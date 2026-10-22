"""Check a saved container image before it is published.

Reads the archive written by ``docker save`` (manifest.json, the image config and one tar per layer)
and refuses the image when any layer, including a file a later layer deletes, carries instance data
or a credential, or when the config's env, labels or history carry a credential.

Instance data is recognised by file name (stores, identities, tokens, keys), not by content. Credentials
are found with the fixed-shape detectors of ``reverie.secret_scan`` (issued key formats, JWTs, private keys),
which run over the raw bytes of every regular file, text or binary and of any size, outside the
third-party trees listed in THIRD_PARTY, except the owned Nix packages listed below.
Those trees hold the base image, Nix dependencies, Debian and npm packages, whose
own tests are full of fake keys, so they are checked by file name only, and the report counts the files
and bytes left unread under each prefix. The heuristic detectors (assignments, entropy, URL user info)
fire on ordinary source code and are not used. Known fixtures are listed in an allow file as
``path<TAB>detector`` lines.

Usage: python3 -m reverie.image_check IMAGE.tar [--allow FILE] [--json OUT]
Exit status 0 when clean, 1 when anything is found, 2 on a malformed archive.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tarfile
import posixpath
from pathlib import PurePosixPath

from reverie import secret_scan

# File names that only a running instance writes. Any of them in any layer refuses the image. Dotenv templates
# (.env.example and the like) are tracked files and pass by name; their contents are read like any other file.
INSTANCE_FILES = re.compile(
    r"(?:^|/)(?:memory\.sqlite(?:-wal|-shm)?|chatrooms\.json|identities\.json|instance\.json|company\.json"
    r"|standing-policy\.json|review\.json|\.env(?:\.(?!(?:example|sample|template)$).+)?|[^/]+\.token|\.git-credentials|\.netrc"
    r"|id_(?:rsa|ecdsa|ed25519)|credentials\.json|auth\.json|\.credentials\.json)$")
# Directories an image must ship empty: they are mount points for instance data and work.
MOUNT_POINTS = ("instances/", "workspace/", "scratch/")
# Dependency trees checked by file name only, except the first-party overrides below.
THIRD_PARTY = ("usr/", "bin/", "sbin/", "lib/", "lib64/", "var/lib/dpkg/", "var/lib/apt/", "var/cache/",
               "opt/yarn-", "opt/reverie/python/lib/", "opt/reverie/apps/web/node_modules/", "nix/store/")
# Reverie installs its own scripts here, inside a third-party tree, so these are read in full.
FIRST_PARTY = ("usr/local/bin/",)
# Reviewed image-package boundary from nix/package.nix and nix/image.nix. Nix
# closures otherwise contain external dependencies, just as usr/ does in apt images.
# Owned outputs: reverie-console-VERSION (excluding lib/reverie/node_modules),
# python3.MINOR-reverie-memory-0.1.0, reverie-VERSION, plus the exact helper identities below.
# Changing these identities requires review here; other closures are external.
NIX_STORE = re.compile(r"^nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-([^/]+)(?:/(.*))?$")
NIX_CONSOLE = re.compile(r"reverie-console-[0-9]+(?:\.[0-9]+)+")
NIX_WRAPPER = re.compile(r"reverie-[0-9]+(?:\.[0-9]+)+")
NIX_MEMORY = re.compile(r"python3\.[0-9]+-reverie-memory-0\.1\.0")
NIX_OWNED_HELPERS = frozenset({
    "reverie-start", "reverie-runtime", "reverie-launcher", "reverie-lock-tools",
    "reverie-install-clis", "reverie-install-clis.mjs", "reverie-request-update",
})
CHUNK = 1024 * 1024
OVERLAP = 16 * 1024  # longer than any detector match, so a match across a chunk boundary is still seen
CREDENTIAL_DETECTORS = ("openai_or_anthropic_key", "stripe_key", "github_token", "slack_token", "aws_access_key",
                        "google_api_key", "google_oauth_token", "huggingface_token", "gitlab_token", "npm_token",
                        "pypi_token", "jwt", "private_key")
_CREDENTIALS = {name: re.compile(secret_scan.PATTERNS[name]) for name in CREDENTIAL_DETECTORS}


def _third_party(path: str) -> str | None:
    if path.startswith(FIRST_PARTY):
        return None
    store = NIX_STORE.fullmatch(path)
    if store:
        package, relative = store.group(1), store.group(2) or ""
        if package in NIX_OWNED_HELPERS or NIX_MEMORY.fullmatch(package) or NIX_WRAPPER.fullmatch(package):
            return None
        if NIX_CONSOLE.fullmatch(package):
            if relative == "lib/reverie/node_modules" or relative.startswith("lib/reverie/node_modules/"):
                return "nix/store/"
            return None
    return next((prefix for prefix in THIRD_PARTY if path.startswith(prefix)), None)


def _detectors(text: str) -> list[str]:
    # Names only, never the matched text, so the report can be shared.
    return [name for name, pattern in _CREDENTIALS.items() if pattern.search(text)]


def _file_detectors(handle) -> list[str]:
    """Detectors that match anywhere in a file's bytes, read in overlapping chunks."""
    found: set[str] = set()
    tail = ""
    while chunk := handle.read(CHUNK):
        window = tail + chunk.decode("latin-1")  # one char per byte, so ASCII key shapes match in binaries
        found.update(_detectors(window))
        tail = window[-OVERLAP:]
    return sorted(found)


def _load_allow(path: str | None) -> set[tuple[str, str]]:
    if not path:
        return set()
    allowed = set()
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith("#"):
                file, _, detector = line.partition("\t")
                allowed.add((file.strip().lstrip("/"), detector.strip()))
    return allowed


def check(archive: str, allow: set[tuple[str, str]] | None = None) -> dict:
    allow = allow or set()
    findings: list[dict] = []
    seen_layers = 0
    unread: dict[str, dict[str, int]] = {prefix: {"files": 0, "bytes": 0} for prefix in THIRD_PARTY}
    with tarfile.open(archive) as outer:
        manifest = json.load(outer.extractfile("manifest.json"))
        if len(manifest) != 1:
            raise ValueError("expected exactly one image in the archive")
        entry = manifest[0]
        config = json.load(outer.extractfile(entry["Config"]))
        for key in ("Env", "Labels", "Entrypoint", "Cmd"):
            value = (config.get("config") or {}).get(key)
            if value:
                for detector in _detectors(json.dumps(value)):
                    findings.append({"where": f"config.{key}", "detector": detector})
        for step in config.get("history") or []:
            for detector in _detectors(step.get("created_by", "")):
                findings.append({"where": "config.history", "detector": detector})
        for index, layer_name in enumerate(entry["Layers"]):
            seen_layers += 1
            with tarfile.open(fileobj=outer.extractfile(layer_name)) as layer:
                for member in layer:
                    path = member.name.removeprefix("./").lstrip("/")
                    name = PurePosixPath(path).name
                    if name.startswith(".wh."):
                        continue  # a deletion marker; the deleted file was checked in its own layer
                    where = f"layer {index}: /{path}"
                    if INSTANCE_FILES.search(path):
                        findings.append({"where": where, "detector": "instance_file"})
                    if not member.isdir() and path.startswith(MOUNT_POINTS):
                        findings.append({"where": where, "detector": "mount_point_not_empty"})
                    if member.issym() or member.islnk():
                        target = _link_target(path, member)
                        if INSTANCE_FILES.search(target):
                            findings.append({"where": where, "detector": "link_to_instance_file"})
                        if f"{target}/".startswith(MOUNT_POINTS):
                            findings.append({"where": where, "detector": "link_into_mount_point"})
                    if not member.isfile():
                        continue
                    prefix = _third_party(path)
                    if prefix:
                        unread[prefix]["files"] += 1
                        unread[prefix]["bytes"] += member.size
                        continue
                    for detector in _file_detectors(layer.extractfile(member)):
                        if (path, detector) not in allow:
                            findings.append({"where": where, "detector": detector})
    return {"layers": seen_layers, "findings": findings, "clean": not findings,
            "unread_third_party": {prefix: count for prefix, count in unread.items() if count["files"]}}


def _link_target(path: str, member: tarfile.TarInfo) -> str:
    """Archive-relative path a symlink or hardlink points at, without a leading slash."""
    target = member.linkname
    if member.issym() and not target.startswith("/"):
        target = posixpath.join(posixpath.dirname(path), target)
    return posixpath.normpath("/" + target.removeprefix("./")).lstrip("/")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m reverie.image_check")
    parser.add_argument("archive")
    parser.add_argument("--allow")
    parser.add_argument("--json")
    args = parser.parse_args(argv)
    try:
        result = check(args.archive, _load_allow(args.allow))
    except (KeyError, ValueError, tarfile.TarError, json.JSONDecodeError) as exc:
        print(f"malformed image archive: {exc}", file=sys.stderr)
        return 2
    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=1)
    for finding in result["findings"]:
        print(f"{finding['detector']}\t{finding['where']}")
    for prefix, count in result["unread_third_party"].items():
        print(f"names only\t/{prefix}\t{count['files']} files, {count['bytes']} bytes")
    print(f"{result['layers']} layers, {len(result['findings'])} findings")
    return 0 if result["clean"] else 1


if __name__ == "__main__":
    sys.exit(main())
