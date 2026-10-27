"""Explicit, local, seed-only maintenance for existing offline employee stores.

This never starts a provider or changes running intent. Its durable employee
migration fence is understood by the ordinary broker, including after a crash.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import selectors
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import uuid

from .worker_docker import require_image
from .worker_nix import private_store, prepare_args
from .worker_storage import (lock_paths, read_metadata, storage_paths,
                             validate_storage)

IMAGE = re.compile(r"sha256:[0-9a-f]{64}")
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
STORE = re.compile(r"/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+")
CID = re.compile(r"[0-9a-f]{64}")
MAX_ENTRIES = 4096
MAX_BYTES = 8 * 1024 * 1024
GIB = 1024**3
OFFLINE_IMAGE_SCOPE = "VALIDATED_OFFLINE_IMAGE_TOOL_SHELL"
OFFLINE_EVIDENCE_SCOPE = "OFFLINE_IMAGE_TOOL_SHELL"
CURRENT_AGENT_SCOPE = "CURRENT_CODEX_TOOL_SHELL_ONLY"


class Refused(RuntimeError):
    """No engine mutation was attempted by this operation."""


class Unconfirmed(RuntimeError):
    """An effect or its durability is uncertain; the employee remains fenced."""


def need(condition, message):
    if not condition:
        raise Refused(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def pin(value):
    return isinstance(value, str) and IMAGE.fullmatch(value) is not None


def _identity(info):
    return [info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)]


@contextmanager
def _parent(path):
    """Pin every directory component without following a link."""
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, "absolute canonical path required")
    fds = [os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)]
    links = []
    try:
        for name in path.parts[1:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fds[-1])
            links.append((fds[-1], name, child))
            fds.append(child)
        yield fds[-1], path.name
        for parent, name, child in links:
            need(_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == _identity(os.fstat(child)), "directory chain changed")
    finally:
        for fd in reversed(fds):
            os.close(fd)


def _private_bytes(path, limit=MAX_BYTES):
    path = Path(path)
    need(path.is_absolute() and path == path.resolve(), "canonical private input required")
    with _parent(path) as (parent, name):
        return _private_at(parent, name, limit)


def _private_at(parent, name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
             and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o600
             and before.st_size <= limit, "bounded owner0600 input required")
        raw = bytearray()
        while len(raw) <= limit:
            part = os.read(fd, min(65536, limit + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
        stamp = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        need(len(raw) == before.st_size
             and stamp(before) == stamp(os.fstat(fd)) == stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)), "input changed")
        return bytes(raw)
    finally:
        os.close(fd)


def _json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refused("non-finite JSON number")))


def _sync_parent(path):
    fd = os.open(Path(path).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _new_record(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        remaining = memoryview(canonical(value))
        while remaining:
            count = os.write(fd, remaining)
            need(count > 0, "short record write")
            remaining = remaining[count:]
        os.fsync(fd)
        identity = _identity(os.fstat(fd))
    finally:
        os.close(fd)
    _sync_parent(path)
    return identity


@contextmanager
def _existing_lock(path, uid):
    """Use the exact broker lock inode; never create a missing replacement."""
    with _parent(path) as (parent, name):
        fd = os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        try:
            s = os.fstat(fd)
            need(stat.S_ISREG(s.st_mode) and s.st_uid == uid and s.st_nlink == 1
                 and stat.S_IMODE(s.st_mode) == 0o600, "existing private native lock required")
            identity = _identity(s)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            def check():
                held = os.fstat(fd); named = os.stat(name, dir_fd=parent, follow_symlinks=False)
                need(_identity(held) == _identity(named) == identity
                     and held.st_nlink == named.st_nlink == 1, "native lock replaced or custody changed")
            check()
            yield check
            check()
        finally:
            os.close(fd)


def _profiles(paths):
    """Bounded metadata inventory through pinned nofollow directory FDs."""
    result = {}
    scopes = [(paths.nix, "var/nix/profiles"), (paths.nix, "var/nix/gcroots"),
              (paths.home, ".nix-profile"), (paths.home, ".local/state/nix/profiles")]
    def visit(parent, name, key, device, depth=0):
        need(len(result) < MAX_ENTRIES and depth <= 24, "profile inventory bound")
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        need(before.st_dev == device and before.st_uid == os.getuid(), "profile ownership/device changed")
        kind = "link" if stat.S_ISLNK(before.st_mode) else "directory" if stat.S_ISDIR(before.st_mode) else "file"
        need(kind != "file" or stat.S_ISREG(before.st_mode), "unsupported profile object")
        value = {"type": kind, "identity": _identity(before)}
        if kind == "link":
            value["target"] = os.readlink(name, dir_fd=parent)
        result[key] = value
        if kind == "directory":
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            try:
                need(_identity(os.fstat(fd)) == _identity(before), "profile directory replaced")
                with os.scandir(fd) as entries:
                    for entry in entries:
                        visit(fd, entry.name, key + "/" + entry.name, device, depth + 1)
                after = os.fstat(fd)
                need((before.st_mtime_ns, before.st_ctime_ns) == (after.st_mtime_ns, after.st_ctime_ns), "profile listing changed")
            finally:
                os.close(fd)
        after = os.stat(name, dir_fd=parent, follow_symlinks=False)
        need(_identity(before) == _identity(after) and (before.st_mtime_ns, before.st_ctime_ns) ==
             (after.st_mtime_ns, after.st_ctime_ns), "profile metadata changed")
    for root, relative in scopes:
        key = ("nix:" if root == paths.nix else "home:") + relative
        path = root / relative
        try:
            with _parent(path) as (parent, name):
                try:
                    visit(parent, name, key, root.stat().st_dev)
                except FileNotFoundError:
                    need(key not in result, "profile object disappeared")
                    need(len(result) < MAX_ENTRIES, "profile inventory bound")
                    result[key] = {"type": "absent"}
        except FileNotFoundError:
            need(len(result) < MAX_ENTRIES, "profile inventory bound")
            result[key] = {"type": "absent"}
    need(len(canonical(result)) <= MAX_BYTES, "profile inventory byte bound")
    return result


FOCUS = "nix:var/nix/gcroots/reverie-image"


def _inode(path):
    try:
        info = Path(path).stat()
        return info.st_dev, info.st_ino
    except FileNotFoundError:
        return None


def _physical_overlap(left, right):
    """Compare endpoint/ancestor identities, including bind aliases."""
    left, right = Path(left), Path(right)
    need(len(left.parts) <= 128 and len(right.parts) <= 128, "path depth bound")
    a, b = _inode(left), _inode(right)
    return ((b is not None and any(_inode(p) == b for p in (left, *left.parents)))
            or (a is not None and any(_inode(p) == a for p in (right, *right.parents))))


def _mount_points():
    """Bounded host namespace mount metadata; no engine or privileged probe."""
    fd = os.open('/proc/self/mountinfo', os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        raw = bytearray()
        while len(raw) <= 2*1024**2:
            chunk = os.read(fd, min(65536, 2*1024**2+1-len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        need(len(raw) <= 2*1024**2, "mount metadata byte bound")
    finally:
        os.close(fd)
    lines = raw.decode().splitlines()
    need(len(lines) <= 4096, "mount metadata count bound")
    points = []
    for line in lines:
        fields = line.split()
        need(len(fields) >= 10 and fields[0].isdigit() and fields[1].isdigit()
             and '-' in fields[6:] and fields[4].startswith('/'), "mount metadata unavailable")
        path = fields[4]
        for encoded, decoded in ((r'\040', ' '), (r'\011', '\t'), (r'\012', '\n'), (r'\134', '\\')):
            path = path.replace(encoded, decoded)
        points.append(Path(path))
    return points


def _overlap(source, protected, mount_points):
    source, protected = Path(source).resolve(), Path(protected).resolve()
    roots = [source] + [point for point in mount_points if point.is_relative_to(source)]
    return any(root == protected or root.is_relative_to(protected) or protected.is_relative_to(root)
               or _physical_overlap(root, protected) for root in roots)


class DockerEngine:
    """Fixed local Docker verbs; neither a shell nor an arbitrary command port."""
    def __init__(self, socket_path):
        executable = shutil.which("docker")
        need(executable is not None, "local Docker client unavailable")
        self.executable = str(Path(executable).resolve())
        endpoint = Path(socket_path)
        need(endpoint.is_absolute() and endpoint == endpoint.resolve()
             and stat.S_ISSOCK(endpoint.lstat().st_mode), "canonical existing local engine socket required")
        self.endpoint = "unix://" + str(endpoint)

    def _run(self, args, timeout=20):
        # Keep binary tar responses binary; bound both pipes before buffering.
        child = subprocess.Popen([self.executable, "--host", self.endpoint, *args],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE)
        output = [bytearray(), bytearray()]
        deadline = time.monotonic() + timeout
        try:
            with selectors.DefaultSelector() as selector:
                for index, stream in enumerate((child.stdout, child.stderr)):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ, index)
                while selector.get_map() or child.poll() is None:
                    need(time.monotonic() < deadline, "engine response deadline")
                    for key, _ in selector.select(min(.05, max(0, deadline-time.monotonic()))):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        else:
                            output[key.data].extend(chunk)
                            need(len(output[key.data]) <= (16*1024**2 if key.data == 0 else 65536), "engine response bound")
            need(child.returncode == 0, "engine operation failed: " + args[0])
            return bytes(output[0])
        finally:
            if child.poll() is None:
                child.kill()  # Only this exact owned CLI child, never the daemon.
                until = time.monotonic() + .1
                while child.poll() is None and time.monotonic() < until:
                    time.sleep(.005)
            child.stdout.close(); child.stderr.close()
            need(child.poll() is not None, "engine client reaping unconfirmed")

    def identity(self):
        return _json(self._run(["info", "--format", "{{json .ID}}"])).strip()

    def image(self, image):
        items = _json(self._run(["image", "inspect", image]))
        need(type(items) is list and len(items) == 1 and items[0].get("Id") == image,
             "exact loaded image unavailable")
        return items[0]

    def containers(self):
        ids = self._run(["ps", "--all", "--quiet", "--no-trunc"]).decode().split()
        need(len(ids) <= 256 and len(set(ids)) == len(ids)
             and all(CID.fullmatch(value) for value in ids), "container inventory unavailable")
        result = []
        for offset in range(0, len(ids), 32):
            result.extend(_json(self._run(["inspect", *ids[offset:offset + 32]])))
        need({v.get("Id") for v in result} == set(ids), "container inventory changed")
        return result

    def inspect(self, cid):
        result = _json(self._run(["inspect", cid]))
        need(type(result) is list and len(result) == 1 and result[0].get("Id") == cid,
             "exact helper identity unavailable")
        return result[0]

    def base_target(self, cid):
        raw = self._run(["cp", cid + ":/etc/reverie-nix-base", "-"])
        need(len(raw) <= 1024**2, "image base metadata bound")
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            items = archive.getmembers()
            need(len(items) == 1 and items[0].issym(), "image base must be an immutable link")
            return items[0].linkname

    def create(self, args):
        cid = self._run(args).decode().strip()
        need(CID.fullmatch(cid) is not None, "created helper identity unknown")
        return cid

    def start(self, cid):
        self._run(["start", cid])

    def remove(self, cid):
        self._run(["rm", cid])  # Stopped, exact CID only; never --force or a name.


class OfflineStoreMaintenance:
    def __init__(self, config_path, target_path, *, engine=None, statvfs=os.statvfs,
                 wall=time.time, clock=time.monotonic, sleep=time.sleep):
        self.config_path, self.target_path = Path(config_path), Path(target_path)
        self.engine = engine
        self.statvfs, self.wall, self.clock, self.sleep = statvfs, wall, clock, sleep

    def _target(self):
        raw = _private_bytes(self.target_path)
        value = _json(raw)
        keys = {"version", "kind", "imageId", "engineId", "engineSocket", "validationContainerId", "baseTarget",
                "closurePaths", "expiresAtEpoch", "cohort", "budget", "receipts"}
        need(type(value) is dict and keys <= set(value) <= keys | {"validationScope"} and type(value["version"]) is int and value["version"] == 1
             and value["kind"] == "reverie.worker-store-target", "closed validated target required")
        scope = value.get("validationScope", CURRENT_AGENT_SCOPE)
        need(scope in (CURRENT_AGENT_SCOPE, OFFLINE_IMAGE_SCOPE), "unsupported validation scope")
        need(pin(value["imageId"]) and CID.fullmatch(value["validationContainerId"] or "")
             and STORE.fullmatch(value["baseTarget"] or ""), "exact validated image/base required")
        need(isinstance(value["engineId"], str) and 1 <= len(value["engineId"]) <= 128
             and not any(ord(c) < 32 for c in value["engineId"]), "exact validated engine identity required")
        expiry = value["expiresAtEpoch"]
        need(type(expiry) in (int, float) and math.isfinite(expiry) and expiry > self.wall(),
             "target qualification expired")
        paths = value["closurePaths"]
        need(type(paths) is list and 1 <= len(paths) <= 32768 and paths == sorted(set(paths))
             and all(isinstance(p, str) and STORE.fullmatch(p) for p in paths)
             and value["baseTarget"] in paths, "bounded image closure required")
        need(type(value["cohort"]) is list and 1 <= len(value["cohort"]) <= 32,
             "explicit bounded offline cohort required")
        for row in value["cohort"]:
            need(type(row) is dict and set(row) == {"employeeId", "sessionId", "sessionGeneration", "employeeDigest"}
                 and UUID.fullmatch(row["employeeId"] or "") and UUID.fullmatch(row["sessionId"] or "")
                 and type(row["sessionGeneration"]) is int and row["sessionGeneration"] > 0
                 and pin(row["employeeDigest"]), "closed current employee cohort required")
        need(len({r["employeeId"] for r in value["cohort"]}) == len(value["cohort"])
             and len({r["sessionId"] for r in value["cohort"]}) == len(value["cohort"]), "duplicate employee/session")
        receipts = value["receipts"]
        need(type(receipts) is dict and set(receipts) == {"D2", "CAN"}, "actual target validation receipts required")
        validation_employee = None
        for kind, reference in receipts.items():
            need(type(reference) is dict and set(reference) == {"path", "digest"} and pin(reference["digest"]), "pinned validation receipt required")
            evidence = _private_bytes(reference["path"], 1024**2)
            need(sha(evidence) == reference["digest"], "validation receipt changed")
            record = _json(evidence)
            need(type(record) is dict and record.get("kind") == kind and type(record.get("version")) is int and record["version"] == 1
                 and record.get("data", {}).get("containerId") == value["validationContainerId"],
                 "actual validation container binding required")
            data = record["data"]
            fields = {"version", "containerId", "rawEvidencePath", "rawEvidenceDigest"}
            fields |= {"imageId", "scope"} if scope == OFFLINE_IMAGE_SCOPE else {"employeeId"}
            fields |= {"jobs"} if kind == "D2" else {"probePath", "probeDigest"}
            if kind == "CAN" and scope == CURRENT_AGENT_SCOPE:
                fields |= {"ownToolShell", "scope"}
            need(type(data) is dict and set(data) == fields and type(data["version"]) is int
                 and data["version"] == 1
                 and pin(data["rawEvidenceDigest"]), "closed canonical validation data required")
            if scope == OFFLINE_IMAGE_SCOPE:
                need(data["scope"] == OFFLINE_EVIDENCE_SCOPE and data["imageId"] == value["imageId"],
                     "offline image evidence must bind its exact image/scope")
            else:
                need(UUID.fullmatch(data["employeeId"] or "")
                     and validation_employee in (None, data["employeeId"]), "validation employee differs between receipts")
                validation_employee = data["employeeId"]
            body = _private_bytes(data["rawEvidencePath"], 1024**2)
            need(sha(body) == data["rawEvidenceDigest"], "raw validation evidence changed")
            text = body.decode()
            if kind == "D2":
                lines = text.splitlines()
                passes = [line for line in lines if line.startswith("PASS ")]
                expected = ["shim body = F1 r7 / Ada r5 (shebang line excluded)",
                            "builder body = r5 (", "cargo resolves to the shim",
                            "shim sets CARGO_BUILD_JOBS=" + str(data["jobs"]),
                            "REVERIE_NO_AUTOENV=1 untouched", "explicit -j left as given"]
                need(type(data.get("jobs")) is int and data["jobs"] > 0
                     and len(passes) == 6 and not any(s.startswith("FAIL") for s in lines)
                     and all(line[5:].startswith(prefix) for line, prefix in zip(passes, expected))
                     and re.search(r"\bjobs=" + str(data["jobs"]) + r"\b", text), "target D2 did not pass")
            else:
                # Exact existing CAN core predicates. Reporting-only probe/T10/
                # EXECPATH fields do not acquire new gating semantics here.
                grep = re.search(r"^GREP pos=(\S+) neg=(\S+) find=(\S+)", text, re.M)
                jobs = re.search(r"jobs=(\S+)", text)
                shims = re.search(r"^SHIMS (\S+) (\S+)", text, re.M)
                need((scope == OFFLINE_IMAGE_SCOPE or
                      data.get("ownToolShell") is True and data.get("scope") == CURRENT_AGENT_SCOPE)
                     and grep is not None and grep.groups() == ("0", "1", "0")
                     and jobs is not None and jobs.group(1).isdigit()
                     and shims is not None and shims.group(1) == "/opt/reverie/autoenv/bin/cargo"
                     and "CAN-DONE" in text, "target own-shell CAN did not pass")
                probe = _private_bytes(data["probePath"], 1024**2)
                need(sha(probe) == data["probeDigest"], "actual own-shell probe bytes changed")
        return value, sha(raw)

    def _budget(self, config, target):
        b = target["budget"]
        need(type(b) is dict and set(b) == {"fullClosureAllocatedBytes", "overheadBytes", "mainFloorBytes", "scratchFloorBytes"}
             and all(type(v) is int and v > 0 for v in b.values()), "finite operator capacity model required")
        charge = 3 * b["fullClosureAllocatedBytes"] * len(target["cohort"]) + b["overheadBytes"]
        main = self.statvfs(config["stateRoot"]); scratch = self.statvfs(config["scratchRoot"])
        need(main.f_bavail * main.f_frsize - charge >= b["mainFloorBytes"]
             and scratch.f_bavail * scratch.f_frsize >= b["scratchFloorBytes"], "capacity model/floor unavailable")
        return {"grossModelBytes": charge, "mainFloorBytes": b["mainFloorBytes"],
                "scratchFloorBytes": b["scratchFloorBytes"], "enforcement": "MODEL_NOT_QUOTA_NO_GC_OR_DEDUP_CREDIT"}

    def _snapshot(self, employee_id):
        raw = _private_bytes(self.config_path)
        from .worker import validate_config
        config = validate_config(_json(raw))
        need(config.get("uid") == os.getuid() and os.getuid() != 0, "ordinary configured host owner required")
        target, target_digest = self._target()
        if self.engine is None:
            self.engine = DockerEngine(target["engineSocket"])
        need(self.engine.identity() == target["engineId"], "validated engine identity changed")
        need(config.get("image") == target["imageId"], "validated target must already be selected for normal next start")
        image = self.engine.image(target["imageId"])
        require_image(config, image)
        need(image["Config"].get("User") == f"{config['uid']}:{config['gid']}"
             and (image["Config"].get("Labels") or {}).get("reverie.worker.nix-store") == "1", "reviewed owner Nix image required")
        validation = self.engine.inspect(target["validationContainerId"])
        need(validation.get("Id") == target["validationContainerId"] and validation.get("Image") == target["imageId"]
             and self.engine.base_target(target["validationContainerId"]) == target["baseTarget"], "qualified image base changed")
        if target.get("validationScope") == OFFLINE_IMAGE_SCOPE:
            self._offline_image_validation(validation, config, target["engineSocket"])
        company = read_metadata(config["companyFile"], config["uid"])
        selected = None
        for admitted in target["cohort"]:
            matches = [e for e in company["employees"] if e.get("id") == admitted["employeeId"]]
            need(len(matches) == 1, "current employee binding unavailable")
            e = matches[0]
            need(e.get("sessionId") == admitted["sessionId"] and e.get("sessionGeneration") == admitted["sessionGeneration"]
                 and e.get("desiredRunning") is False and e.get("onVacation") is True
                 and not e.get("bindingMigration") and sha(canonical(e)) == admitted["employeeDigest"], "offline employee/cohort changed")
            if e["id"] == employee_id:
                selected = e
        need(selected is not None, "employee is outside the admitted offline cohort")
        paths = storage_paths(config, selected["sessionId"])
        need(paths.kind == "employee" and paths.identity == employee_id, "current canonical employee store required")
        validate_storage(config, paths)
        lock, fence = lock_paths(config, paths)
        need(not fence.exists() and not fence.is_symlink(), "employee maintenance/migration remains fenced")
        sid_lock = Path(config["stateRoot"]) / paths.session / "nix.lock"
        for item in (lock, sid_lock):
            s = item.lstat()
            need(stat.S_ISREG(s.st_mode) and s.st_uid == config["uid"] and s.st_nlink == 1
                 and stat.S_IMODE(s.st_mode) == 0o600,
                 "both existing native locks required")
        need(_identity(lock.lstat())[:2] != _identity(sid_lock.lstat())[:2], "distinct native lock inodes required")
        containers = self.engine.containers()
        helper_name, args = prepare_args(config, paths.session, paths.nix)
        need(not any(v.get("Name") == "/" + helper_name for v in containers), "existing helper must be reconciled, never removed by name")
        private = [self.config_path.resolve(), self.target_path.resolve(), lock.parent.resolve(),
                   (Path(config["stateRoot"]) / "offline-store-maintenance").resolve()]
        for reference in target["receipts"].values():
            private.append(Path(reference["path"]).resolve())
            receipt = _json(_private_bytes(reference["path"], 1024**2))
            private.append(Path(receipt["data"]["rawEvidencePath"]).resolve())
            if "probePath" in receipt["data"]:
                private.append(Path(receipt["data"]["probePath"]).resolve())
        # Account paths are selected dynamically at normal launch. Exclude the
        # whole source namespace rather than guessing today's selected profile.
        # Cold employee homes/stores can become future grants without an
        # existing container, so exclude those namespaces too.
        future = [m["source"] for m in config["mounts"]] + [config["companyRoot"],
                  str(Path(config["stateRoot"])/"employees"),
                  str(Path(config["scratchRoot"])/"employees")]
        exposed = containers + [{"Mounts": [{"Type": "bind", "Source": source} for source in future]}]
        mount_points = _mount_points()
        for item in exposed:
            for mount in item.get("Mounts", []):
                if mount.get("Type") != "bind":
                    continue
                source = Path(mount["Source"]).resolve()
                need(not any(_overlap(source, p, mount_points) for p in private),
                     "maintenance control is exposed through a container bind")
                if mount.get("RW") and item.get("State", {}).get("Running"):
                    need(not any(_overlap(source, p, mount_points) for p in (paths.home, paths.nix)),
                         "another running container owns employee data")
        budget = self._budget(config, target)
        profiles = _profiles(paths)
        need(profiles.get(FOCUS, {}).get("type") == "link"
             and STORE.fullmatch(profiles[FOCUS].get("target", "")), "existing image GCroot required")
        stopped = sorted(item["Id"] for item in containers
                         if any(m.get("Type") == "bind" and m.get("Source") in (str(paths.home), str(paths.nix))
                                for m in item.get("Mounts", [])))
        return config, target, paths, {"configDigest": sha(raw), "targetDigest": target_digest,
            "employeeDigest": sha(canonical(selected)), "homeIdentity": _identity(paths.home.stat()),
            "nixIdentity": _identity(paths.nix.stat()), "lockIdentity": _identity(lock.lstat()),
            "sidLockIdentity": _identity(sid_lock.lstat()), "profiles": profiles, "budget": budget,
            "stoppedContainerIds": stopped,
            "helperArgs": args, "helperName": helper_name}

    def _offline_image_validation(self, container, config, engine_socket):
        """Inspect actual isolated image-check context; never call it an agent shell."""
        host = container.get("HostConfig", {})
        need(container.get("Config", {}).get("User") == f"{config['uid']}:{config['gid']}"
             and host.get("NetworkMode") == "none" and host.get("ReadonlyRootfs") is True
             and not host.get("Privileged") and not host.get("CapAdd")
             and host.get("CapDrop") == ["ALL"]
             and host.get("PidMode", "") == "" and host.get("IpcMode", "private") == "private"
             and host.get("UsernsMode", "") == "" and not host.get("VolumesFrom")
             and any(v in ("no-new-privileges", "no-new-privileges:true") for v in host.get("SecurityOpt", []))
             and type(host.get("Memory")) is int and 0 < host["Memory"] <= 4*GIB
             and host.get("MemorySwap") == host["Memory"]
             and type(host.get("PidsLimit")) is int and 0 < host["PidsLimit"] <= 256
             and type(host.get("NanoCpus")) is int and 0 < host["NanoCpus"] <= 2_000_000_000,
             "offline image check sandbox differs")
        points = _mount_points()
        private = [Path(config["companyRoot"]), Path(config["stateRoot"])/"employees",
                   Path(config["scratchRoot"])/"employees", Path(config["apiSocketRoot"]),
                   Path(config["socket"]), Path(engine_socket)]
        for mount in container.get("Mounts", []):
            if mount.get("Type") == "tmpfs":
                continue
            need(mount.get("Type") == "bind" and
                 (mount.get("RW") is False or mount.get("Destination") == "/output"),
                 "offline image check has unexpected writable grant")
            destination = Path(mount["Destination"])
            source = Path(mount["Source"]).resolve()
            source_mode = source.stat().st_mode
            need(stat.S_ISREG(source_mode) or stat.S_ISDIR(source_mode),
                 "offline image check cannot borrow sockets or devices")
            need(not any(destination == p or destination.is_relative_to(p)
                         for p in map(Path, ("/home/agent", "/nix", "/instances", "/reverie_workspace", "/run"))),
                 "offline image check cannot borrow private runtime mounts")
            need(not any(_overlap(source, p, points) for p in private),
                 "offline image check has private employee/account source")

    def plan(self, employee_id, operation_id):
        need(UUID.fullmatch(operation_id or "") and UUID.fullmatch(employee_id or ""), "exact operation/employee UUID required")
        config, target, paths, facts = self._snapshot(employee_id)
        audit = Path(config["stateRoot"]) / "offline-store-maintenance" / (operation_id + ".json")
        need(not audit.exists() and not audit.is_symlink(), "operation already recorded; never retry it")
        body = {"version": 1, "kind": "reverie.offline-store.plan", "operationId": operation_id,
                "employeeId": employee_id, "sessionId": paths.session, "imageId": target["imageId"], "facts": facts}
        return dict(body, planDigest=sha(canonical(body)))

    def _adjacent_admission(self, config, target, facts):
        """No fence resolver or engine call: repeat after slow native operations."""
        need(self.wall() < target["expiresAtEpoch"], "target qualification expired before effect")
        need(sha(_private_bytes(self.config_path)) == facts["configDigest"]
             and sha(_private_bytes(self.target_path)) == facts["targetDigest"], "adjacent target/config changed")
        company = read_metadata(config["companyFile"], config["uid"])
        for admitted in target["cohort"]:
            rows = [e for e in company["employees"] if e.get("id") == admitted["employeeId"]]
            need(len(rows) == 1 and sha(canonical(rows[0])) == admitted["employeeDigest"],
                 "adjacent offline cohort changed")
        self._budget(config, target)
        need(self.wall() < target["expiresAtEpoch"], "target expired during admission")

    def apply(self, employee_id, operation_id, expected_plan_digest, timeout=300):
        outcome = {"uncertain": False}
        try:
            return self._apply(employee_id, operation_id, expected_plan_digest, timeout, outcome)
        except Exception as error:
            if outcome["uncertain"]:
                raise Unconfirmed("offline outcome or cleanup unconfirmed; do not retry; reconcile employee fence") from error
            raise

    def _apply(self, employee_id, operation_id, expected_plan_digest, timeout, outcome):
        need(type(timeout) is int and 1 <= timeout <= 300, "bounded helper timeout required")
        plan = self.plan(employee_id, operation_id)
        need(plan["planDigest"] == expected_plan_digest, "offline plan changed; no mutation attempted")
        config, target, paths, facts = self._snapshot(employee_id)
        need(facts == plan["facts"], "offline admission changed")
        lock, fence = lock_paths(config, paths)
        sid_lock = Path(config["stateRoot"]) / paths.session / "nix.lock"
        uncertain = False
        result = None
        marker = None
        marker_identity = None
        with _existing_lock(lock, config["uid"]) as check_storage_lock, _existing_lock(sid_lock, config["uid"]) as check_nix_lock:
            # Common installed resolver/fence checks run BEFORE our own marker exists.
            need(private_store(config, paths.session) == paths.nix, "private store selection changed")
            need(self._snapshot(employee_id)[3] == facts, "locked admission changed")
            marker = {"version": 1, "kind": "reverie.offline-store-maintenance", "operationId": operation_id,
                      "employeeId": employee_id, "sessionId": paths.session, "planDigest": plan["planDigest"],
                      "state": "PREPARED", "imageId": target["imageId"]}
            marker_identity = None
            try:
                # From this point any failure retains a broker-recognized fence.
                uncertain = True
                outcome["uncertain"] = True
                marker_identity = _new_record(fence, marker)
                audit_dir = Path(config["stateRoot"]) / "offline-store-maintenance"
                audit_dir.mkdir(mode=0o700, exist_ok=True)
                need(audit_dir == audit_dir.resolve() and _identity(audit_dir.stat())[2:] == [config["uid"], 0o700], "private audit directory required")
                audit = audit_dir / (operation_id + ".json")
                _new_record(audit, {"state": "PREPARED", "plan": plan})
                args = list(facts["helperArgs"])
                args[1:1] = ["--label", "reverie.offline-store-operation=" + operation_id, "--restart", "no"]
                self._adjacent_admission(config, target, facts)
                check_storage_lock(); check_nix_lock()
                need(_identity(fence.lstat()) == marker_identity and read_metadata(fence, config["uid"]) == marker,
                     "own fence changed before create")
                cid = self.engine.create(args)
                need(CID.fullmatch(cid or ""), "helper create identity unconfirmed")
                self._helper(self.engine.inspect(cid), config, paths, operation_id, target)
                self._adjacent_admission(config, target, facts)
                check_storage_lock(); check_nix_lock()
                need(_identity(fence.lstat()) == marker_identity and read_metadata(fence, config["uid"]) == marker,
                     "own fence changed before start")
                self.engine.start(cid)
                deadline = self.clock() + timeout
                while True:
                    check_storage_lock(); check_nix_lock()
                    need(_identity(fence.lstat()) == marker_identity and read_metadata(fence, config["uid"]) == marker,
                         "own maintenance fence changed")
                    # Recheck real canonical flags without deleting/bypassing our own fence.
                    company = read_metadata(config["companyFile"], config["uid"])
                    for admitted in target["cohort"]:
                        current = [e for e in company["employees"] if e.get("id") == admitted["employeeId"]]
                        need(len(current) == 1 and sha(canonical(current[0])) == admitted["employeeDigest"], "offline intent or identity changed during seed")
                    need(sha(_private_bytes(self.config_path)) == facts["configDigest"]
                         and sha(_private_bytes(self.target_path)) == facts["targetDigest"]
                         and self.wall() < target["expiresAtEpoch"], "target/config authority changed")
                    self._budget(config, target)
                    state = self.engine.inspect(cid)
                    need(state.get("Id") == cid, "helper CID changed")
                    self._helper(state, config, paths, operation_id, target)
                    if state["State"]["Running"] is False:
                        need(state["State"].get("Status") == "exited" and state["State"].get("Pid") == 0
                             and type(state["State"].get("ExitCode")) is int and state["State"]["ExitCode"] == 0,
                             "helper failed or never started; diagnostics/fence retained")
                        break
                    need(self.clock() < deadline, "seed deadline expired; completion unconfirmed")
                    self.sleep(.25)
                after = _profiles(paths)
                need(after.get(FOCUS, {}).get("target") == target["baseTarget"]
                     and {k: v for k, v in after.items() if k != FOCUS} == {k: v for k, v in facts["profiles"].items() if k != FOCUS}, "non-image profile/link metadata changed")
                store = os.open(paths.nix / "store", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    for registered in target["closurePaths"]:
                        s = os.stat(Path(registered).name, dir_fd=store, follow_symlinks=False)
                        need(stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode) or stat.S_ISLNK(s.st_mode), "closure path unavailable")
                finally:
                    os.close(store)
                self.engine.remove(cid)
                final_containers = self.engine.containers()
                need(not any(v.get("Id") == cid for v in final_containers), "helper removal unconfirmed")
                need(set(facts["stoppedContainerIds"]) <= {v.get("Id") for v in final_containers}, "existing stopped container changed")
                for v in final_containers:
                    if v.get("State", {}).get("Running"):
                        for m in v.get("Mounts", []):
                            if m.get("Type") == "bind" and m.get("RW"):
                                source = Path(m["Source"]).resolve()
                                need(not any(_overlap(source, p, _mount_points()) for p in (paths.home, paths.nix)),
                                     "employee data acquired a foreign writer")
                need(sha(_private_bytes(self.config_path)) == facts["configDigest"]
                     and sha(_private_bytes(self.target_path)) == facts["targetDigest"], "final target/config changed")
                final_company = read_metadata(config["companyFile"], config["uid"])
                for admitted in target["cohort"]:
                    rows = [e for e in final_company["employees"] if e.get("id") == admitted["employeeId"]]
                    need(len(rows) == 1 and sha(canonical(rows[0])) == admitted["employeeDigest"], "final offline cohort changed")
                result = {"version": 1, "kind": "reverie.offline-store.receipt", "state": "STORE_PREPARED",
                          "operationId": operation_id, "employeeId": employee_id, "sessionId": paths.session,
                          "imageId": target["imageId"], "helperContainerId": cid, "planDigest": plan["planDigest"],
                          "offVacationPreserved": True, "providerLaunched": False, "containerAdoption": "NOT_RUN",
                          "databaseObserverReads": False, "profileInventoryDigest": sha(canonical(after))}
                if target.get("validationScope") == OFFLINE_IMAGE_SCOPE:
                    result.update(state="STORE_PREPARED_RUNTIME_ACCEPTANCE_PENDING",
                                  validationScope=OFFLINE_IMAGE_SCOPE, runtimeAcceptance="PENDING")
                _new_record(audit_dir / (operation_id + ".prepared-store.json"), result)
                need(_identity(fence.lstat()) == marker_identity and read_metadata(fence, config["uid"]) == marker, "own fence changed before completion")
            except Exception as error:
                if uncertain:
                    raise Unconfirmed("offline store outcome requires reconciliation; retain employee fence and do not retry") from error
                raise
        # All engine work and native lock cleanup completed. The fence blocks a
        # normal broker during this final commit interval, without holding data FDs.
        need(_identity(fence.lstat()) == marker_identity
             and read_metadata(fence, config["uid"]) == marker, "own final fence changed")
        try:
            fence.unlink(); _sync_parent(fence)
        except Exception:
            # Best effort to retain a named hold if unlink durability was unknown.
            if not fence.exists() and not fence.is_symlink():
                try:
                    _new_record(fence, dict(marker, state="COMPLETION_UNCONFIRMED"))
                except Exception:
                    pass
            raise
        return result

    @staticmethod
    def _helper(item, config, paths, operation, target):
        labels = item.get("Config", {}).get("Labels") or {}
        need(item.get("Image") == target["imageId"] and labels.get("reverie.nix-prepare") == config["deployment"]
             and labels.get("reverie.session") == paths.session and labels.get("reverie.offline-store-operation") == operation,
             "exact seed helper identity changed")
        need(item["Config"].get("User") == f"{config['uid']}:{config['gid']}"
             and item["Config"].get("Entrypoint") == ["/bin/reverie-nix-store-prepare"], "fixed unprivileged seed entrypoint required")
        host = item["HostConfig"]
        state = item.get("State", {})
        need(type(state.get("Running")) is bool and type(state.get("Pid")) is int and state["Pid"] >= 0,
             "helper process state unknown")
        need(host.get("ReadonlyRootfs") is True and host.get("NetworkMode") == "none"
             and host.get("Privileged") is False and host.get("CapDrop") == ["ALL"]
             and not host.get("CapAdd") and host.get("Memory") == 512 * 1024**2
             and host.get("MemorySwap") == 512 * 1024**2 and host.get("PidsLimit") == 128
             and host.get("NanoCpus") == 1000000000
             and (host.get("RestartPolicy") or {}).get("Name", "") in ("", "no")
             and any(v in ("no-new-privileges", "no-new-privileges:true") for v in host.get("SecurityOpt", [])),
             "fixed helper isolation/resource limits required")
        rw = [m for m in item.get("Mounts", []) if m.get("Type") == "bind" and m.get("RW")]
        need(len(rw) == 1 and rw[0].get("Source") == str(paths.nix) and rw[0].get("Destination") == "/target/nix",
             "helper may write only this employee private Nix store")
        need(all(m.get("Destination") in ("/target/nix", "/etc/passwd", "/etc/group") for m in item.get("Mounts", []) if m.get("Type") == "bind"), "provider/home/account/workspace bind forbidden")
        need(all(m.get("Type") in ("bind", "tmpfs") for m in item.get("Mounts", [])), "unexpected helper volume")
        need(set(host.get("Tmpfs", {})) == {"/tmp", "/nix/store/.links"}, "fixed helper temporary mounts required")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--validated-target", required=True)
    parser.add_argument("--employee", required=True)
    parser.add_argument("--operation", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-plan-digest")
    args = parser.parse_args(argv)
    try:
        maintenance = OfflineStoreMaintenance(args.config, args.validated_target)
        if args.apply:
            need(pin(args.expected_plan_digest), "explicit expected plan digest required")
            result = maintenance.apply(args.employee, args.operation, args.expected_plan_digest)
        else:
            result = maintenance.plan(args.employee, args.operation)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({"state": "UNCONFIRMED" if isinstance(error, Unconfirmed) else "REFUSED",
                          "reason": str(error), "automaticRetry": False}), file=sys.stderr)
        return 4 if isinstance(error, Unconfirmed) else 3


if __name__ == "__main__":
    raise SystemExit(main())
