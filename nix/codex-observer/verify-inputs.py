"""Public source/vendor input qualification only; never launches Codex."""
import hashlib
import json
from pathlib import Path
import re
import sys
import tomllib


def verify(mode, root, provenance, git_hashes):
    expected = json.loads(provenance.read_text())
    hashes = json.loads(git_hashes.read_text())
    lock = root / ("codex-rs/Cargo.lock" if mode == "source" else "Cargo.lock")
    if hashlib.sha256(lock.read_bytes()).hexdigest() != expected["lockSha256"]:
        raise ValueError("reconciled lock mismatch")
    packages = tomllib.loads(lock.read_text())["package"]
    groups = {}
    registry = []
    for package in packages:
        source = package.get("source", "")
        if source.startswith("git+"):
            groups.setdefault(source, []).append(package["name"] + "-" + package["version"])
        elif source.startswith("registry+"):
            if not re.fullmatch(r"[0-9a-f]{64}", package.get("checksum", "")):
                raise ValueError("registry checksum unavailable")
            registry.append(package)
    if set(groups) != set(expected["gitSources"]):
        raise ValueError("unexpected Git source/revision")
    keys = {names[0] for names in groups.values()}
    if set(hashes) != keys or any(not re.fullmatch(r"sha256-[A-Za-z0-9+/]{43}=", value) for value in hashes.values()):
        raise ValueError("missing, extra or invalid actual Git output hash")
    for source, names in groups.items():
        pin = expected["gitSources"][source]
        if pin["outputHashKey"] != names[0] or hashes[names[0]] != pin["hash"]:
            raise ValueError("Git hash differs from qualified source manifest")
    if len(registry) != expected["registryPackages"]:
        raise ValueError("registry package count mismatch")
    if mode == "source":
        for relative, digest in expected["patchedFiles"].items():
            path = root / relative
            if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise ValueError("reviewed patched source mismatch: " + relative)
    elif mode == "vendor":
        config = tomllib.loads((root / ".cargo/config.toml").read_text())["source"]
        if config["crates-io"].get("replace-with") != "vendored-sources":
            raise ValueError("registry not locked to vendor directory")
        wanted = {p["name"] + "-" + p["version"] for p in packages if "source" in p}
        if {p.name for p in root.iterdir() if p.name not in {".cargo", "Cargo.lock"}} != wanted:
            raise ValueError("vendor crate set mismatch")
        for name in wanted:
            crate = root / name
            if not crate.is_dir() or not (crate / ".cargo-checksum.json").is_file():
                raise ValueError("incomplete vendored crate: " + name)
    else:
        raise ValueError("unknown qualification mode")
    return {"state": "PUBLIC_INPUTS_QUALIFIED", "mode": mode, "gitSources": len(groups),
            "registryPackages": len(registry), "nativeBuildOrRuntimeAcceptance": False}


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit("usage: verify-inputs.py source|vendor ROOT PROVENANCE GIT_HASHES")
    print(json.dumps(verify(sys.argv[1], *(Path(p) for p in sys.argv[2:])), sort_keys=True))
