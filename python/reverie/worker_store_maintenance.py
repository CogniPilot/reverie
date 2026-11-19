"""Explicit, local, seed-only maintenance for existing offline employee stores.

This never starts a provider or changes running intent. Its durable employee
migration fence is understood by the ordinary broker, including after a crash.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import stat
import subprocess
import sys
import time
from types import SimpleNamespace
import uuid

from .worker_docker import require_image
from .worker_storage import read_metadata

IMAGE = re.compile(r"sha256:[0-9a-f]{64}")
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
STORE = re.compile(r"/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+")
CID = re.compile(r"[0-9a-f]{64}")
MAX_ENTRIES = 4096
OFFLINE_IMAGE_SCOPE = "VALIDATED_OFFLINE_IMAGE_TOOL_SHELL"
OFFLINE_EVIDENCE_SCOPE = "OFFLINE_IMAGE_TOOL_SHELL"


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


def _json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refused("non-finite JSON number")))


def _native_observation(action, *, timeout=20, worker="qualification", **fields):
    request = {action: fields}
    try:
        result = subprocess.run(
            ["reverie-admin-memory", f"--offline-store-{worker}-worker={os.getpid()}"],
            input=json.dumps(request, separators=(",", ":"), allow_nan=False).encode(),
            capture_output=True, check=True, start_new_session=True, timeout=timeout,
        )
        reply = _json(result.stdout)
        need(isinstance(reply, dict), "native qualification response unavailable")
        if "error" not in reply:
            return base64.b64decode(reply["bytes"], validate=True), reply
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        raise Refused(f"native offline-store {action} observation could not be completed") from error
    if reply.get("errno") is not None:
        raise OSError(reply["errno"], os.strerror(reply["errno"]))
    raise Refused(reply["error"])


def _native_path(path):
    return base64.b64encode(os.fsencode(path)).decode("ascii")


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
    """Read the bounded native profile inventory using the legacy JSON format."""
    raw, _ = _native_observation(
        "profiles", home=list(map(ord, os.fspath(paths.home))),
        nix=list(map(ord, os.fspath(paths.nix))), entries=MAX_ENTRIES,
    )
    return _json(raw)


FOCUS = "nix:var/nix/gcroots/reverie-image"


def _check_mounts(phase, containers, paths, *, controls=None, future=()):
    stores = [_native_path(paths.home), _native_path(paths.nix)]
    for offset in range(0, max(1, len(containers)), 32):
        batch = containers[offset:offset + 32]
        rows = [{"State": {"Running": row.get("State", {}).get("Running")},
                 "Mounts": row.get("Mounts", [])} for row in batch]
        fields = {} if controls is None else {
            "controls": [_native_path(path) for path in controls],
            "future": [_native_path(path) for path in future] if offset + 32 >= len(containers) else [],
        }
        _native_observation(phase, worker="custody", rows=rows, stores=stores, **fields)


class DockerEngine:
    """Fixed local Docker verbs; neither a shell nor an arbitrary command port."""
    def __init__(self, socket_path):
        executable = shutil.which("docker")
        need(executable is not None, "local Docker client unavailable")
        self.executable = str(Path(executable).resolve())
        endpoint = Path(socket_path)
        need(endpoint.is_absolute() and endpoint == endpoint.resolve()
             and stat.S_ISSOCK(endpoint.lstat().st_mode), "canonical existing local engine socket required")
        self.socket_path = _native_path(endpoint)
        self.endpoint = "unix://" + str(endpoint)

    def _run(self, args, timeout=20):
        # Bound both pipes for the three remaining mutating commands.
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

    def _observe(self, query, **fields):
        raw, _ = _native_observation("engine", socket=self.socket_path, query={query: fields}, timeout=25)
        return _json(raw)

    def identity(self):
        return self._observe("identity")

    def image(self, image):
        return self._observe("image", image=image)[0]

    def containers(self):
        ids = self._observe("inventory")
        return [row for offset in range(0, len(ids), 32)
                for row in self._observe("inspect", ids=ids[offset:offset + 32])]

    def inspect(self, cid):
        return self._observe("inspect", ids=[cid])[0]

    def base_target(self, cid):
        return self._observe("base", id=cid)

    def create(self, args):
        cid = self._run(args).decode().strip()
        need(CID.fullmatch(cid) is not None, "created helper identity unknown")
        return cid

    def start(self, cid):
        self._run(["start", cid])

    def remove(self, cid):
        self._run(["rm", cid])  # Stopped, exact CID only; never --force or a name.


class OfflineStoreMaintenance:
    def __init__(self, config_path, target_path, *, engine=None,
                 wall=time.time, clock=time.monotonic, sleep=time.sleep):
        self.config_path, self.target_path = Path(config_path), Path(target_path)
        self.engine = engine
        self.wall, self.clock, self.sleep = wall, clock, sleep

    def _target(self):
        raw, reply = _native_observation("target", target=_native_path(self.target_path), now=self.wall())
        need(sha(raw) == reply["targetDigest"], "qualified target bytes changed")
        target = _json(raw)
        need(target["expiresAtEpoch"] > self.wall(), "target qualification expired")
        return target, reply["targetDigest"], reply["evidencePaths"]

    def _budget(self, config, target):
        raw, _ = _native_observation(
            "capacity", budget=target["budget"], cohort_size=len(target["cohort"]),
            state=_native_path(config["stateRoot"]), scratch=_native_path(config["scratchRoot"]),
        )
        return _json(raw)

    def _cohort(self, config, config_digest, target_digest, employee=None):
        raw, _ = _native_observation(
            "cohort", company=_native_path(config["companyFile"]), employee=employee,
            config={"path": _native_path(self.config_path), "digest": config_digest},
            target={"path": _native_path(self.target_path), "digest": target_digest},
        )
        return _json(raw)

    def _seat(self, config_digest, session, employee, *, recheck=False):
        raw, _ = _native_observation(
            "seat", session=session, employee=employee, recheck_session_fence=recheck,
            config={"path": _native_path(self.config_path), "digest": config_digest},
        )
        seat = _json(raw)
        for key in ("home", "nix", "lock", "fence", "session_lock"):
            seat[key] = Path(os.fsdecode(base64.b64decode(seat[key], validate=True)))
        seat["helper_name"] = "".join(map(chr, seat["helper_name"]))
        seat["helper_args"] = ["".join(map(chr, arg)) for arg in seat["helper_args"]]
        return SimpleNamespace(**seat)

    def _snapshot(self, employee_id):
        raw, _ = _native_observation("config", config=_native_path(self.config_path))
        config_digest = sha(raw)
        config = _json(raw)
        target, target_digest, evidence_paths = self._target()
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
        selected = self._cohort(config, config_digest, target_digest, employee_id)
        paths = self._seat(config_digest, selected["sessionId"], employee_id)
        containers = self.engine.containers()
        need(not any(v.get("Name") == "/" + paths.helper_name for v in containers), "existing helper must be reconciled, never removed by name")
        private = [self.config_path, self.target_path, paths.lock.parent,
                   Path(config["stateRoot"]) / "offline-store-maintenance", *evidence_paths]
        # Account paths are selected dynamically at normal launch. Exclude the
        # whole source namespace rather than guessing today's selected profile.
        # Cold employee homes/stores can become future grants without an
        # existing container, so exclude those namespaces too.
        future = [m["source"] for m in config["mounts"]] + [config["companyRoot"],
                  str(Path(config["stateRoot"])/"employees"),
                  str(Path(config["scratchRoot"])/"employees")]
        _check_mounts("plan", containers, paths, controls=private, future=future)
        budget = self._budget(config, target)
        profiles = _profiles(paths)
        need(profiles.get(FOCUS, {}).get("type") == "link"
             and STORE.fullmatch(profiles[FOCUS].get("target", "")), "existing image GCroot required")
        stopped = sorted(item["Id"] for item in containers
                         if any(m.get("Type") == "bind" and m.get("Source") in (str(paths.home), str(paths.nix))
                                for m in item.get("Mounts", [])))
        return config, target, paths, {"configDigest": config_digest, "targetDigest": target_digest,
            "employeeDigest": selected["employeeDigest"], "homeIdentity": _identity(paths.home.stat()),
            "nixIdentity": _identity(paths.nix.stat()), "lockIdentity": _identity(paths.lock.lstat()),
            "sidLockIdentity": _identity(paths.session_lock.lstat()), "profiles": profiles, "budget": budget,
            "stoppedContainerIds": stopped,
            "helperArgs": paths.helper_args, "helperName": paths.helper_name}

    def _offline_image_validation(self, container, config, engine_socket):
        private = [Path(config["companyRoot"]), Path(config["stateRoot"])/"employees",
                   Path(config["scratchRoot"])/"employees", Path(config["apiSocketRoot"]),
                   Path(config["socket"]), Path(engine_socket)]
        _native_observation("validation", worker="custody", row=container,
                            protected=[_native_path(path) for path in private],
                            uid=config["uid"], gid=config["gid"])

    def plan(self, employee_id, operation_id):
        need(UUID.fullmatch(operation_id or "") and UUID.fullmatch(employee_id or ""), "exact operation/employee UUID required")
        config, target, paths, facts = self._snapshot(employee_id)
        audit = Path(config["stateRoot"]) / "offline-store-maintenance" / (operation_id + ".json")
        need(not audit.exists() and not audit.is_symlink(), "operation already recorded; never retry it")
        raw, _ = _native_observation(
            "plan", employee=employee_id, operation=operation_id, session=paths.session,
            image=target["imageId"], facts=facts,
        )
        return _json(raw)

    def _adjacent_admission(self, config, target, facts):
        """No fence resolver or engine call: repeat after slow native operations."""
        need(self.wall() < target["expiresAtEpoch"], "target qualification expired before effect")
        self._cohort(config, facts["configDigest"], facts["targetDigest"])
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
        lock, fence, sid_lock = paths.lock, paths.fence, paths.session_lock
        uncertain = False
        result = None
        marker = None
        marker_identity = None
        with _existing_lock(lock, config["uid"]) as check_storage_lock, _existing_lock(sid_lock, config["uid"]) as check_nix_lock:
            # Common installed resolver/fence checks run BEFORE our own marker exists.
            need(self._seat(facts["configDigest"], paths.session, employee_id, recheck=True) == paths,
                 "private store selection changed")
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
                    self._cohort(config, facts["configDigest"], facts["targetDigest"])
                    need(self.wall() < target["expiresAtEpoch"], "target qualification expired during seed")
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
                _check_mounts("settled", final_containers, paths)
                self._cohort(config, facts["configDigest"], facts["targetDigest"])
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
