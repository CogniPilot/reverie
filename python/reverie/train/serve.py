"""A dedicated llama-server for CTO with adapter files loaded at start, plus restart-based swap.

The shared router loads its presets from an immutable file in the nix store, and
llama-server cannot add adapter files at runtime, so a newly trained adapter needs a
server started with ``--lora-init-without-apply --lora <gguf>``. This module starts
and stops such a server (pid and adapter list recorded in ``serve.json``), enables the
new adapter by scale, runs the persona check, and on failure restores the previous
adapter set, restarting again if the scale-only rollback is not enough.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Sequence

from .swap import CheckResult, list_adapters, set_adapters
from reverie import env_names


@dataclass
class ServeConfig:
    llama_server: str = os.environ.get("LLAMA_SERVER", shutil.which("llama-server") or "llama-server")
    model_path: str = env_names.lookup("REVERIE_GGUF", str(Path.home() / ".local/share/reverie/models/model.gguf"))
    alias: str = env_names.lookup("REVERIE_MODEL", "MODEL_ID")
    host: str = "127.0.0.1"
    port: int = int(env_names.lookup("REVERIE_SERVE_PORT", "8081"))
    ctx_size: int = 32768
    extra_args: list[str] = field(default_factory=lambda: [
        "--n-gpu-layers", "all", "--flash-attn", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0",
        "--parallel", "1", "--threads", "8", "--n-predict", "4096", "--reasoning-effort", "low",
        "--temperature", "0.7", "--top-k", "20", "--top-p", "0.8", "--min-p", "0.0",
    ])
    state_path: Path = field(default_factory=lambda: Path.home() / ".local/share/reverie/serve.json")
    health_timeout: int = 300

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def command(self, adapters: Sequence[str]) -> list[str]:
        cmd = [self.llama_server, "--host", self.host, "--port", str(self.port), "--alias", self.alias,
               "--model", self.model_path, "--ctx-size", str(self.ctx_size), *self.extra_args]
        if adapters:
            cmd += ["--lora-init-without-apply"]
            for a in adapters:
                cmd += ["--lora", str(a)]
        return cmd


def _http(method: str, url: str, body: bytes | None) -> bytes:
    req = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


class Server:
    def __init__(self, cfg: ServeConfig, popen=subprocess.Popen, http=_http, sleep=time.sleep):
        self.cfg = cfg
        self._popen = popen
        self._http = http
        self._sleep = sleep

    # ---- state ---------------------------------------------------------
    def state(self) -> dict:
        try:
            return json.loads(Path(self.cfg.state_path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save(self, pid: int | None, adapters: Sequence[str], active: str | None) -> None:
        p = Path(self.cfg.state_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"pid": pid, "adapters": list(adapters), "active": active, "at": time.time()}, indent=2))

    def healthy(self) -> bool:
        try:
            d = json.loads(self._http("GET", self.cfg.url + "/health", None))
            return d.get("status") == "ok"
        except Exception:
            return False

    def wait_healthy(self) -> bool:
        deadline = time.time() + self.cfg.health_timeout
        while time.time() < deadline:
            if self.healthy():
                return True
            self._sleep(2)
        return False

    # ---- lifecycle -----------------------------------------------------
    def start(self, adapters: Sequence[str] = (), active: str | None = None) -> int:
        proc = self._popen(self.cfg.command(adapters), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self._save(proc.pid, adapters, None)
        if not self.wait_healthy():
            self.stop()
            raise RuntimeError("llama-server did not become healthy")
        if active:
            self.activate(active, adapters)
        self._save(proc.pid, adapters, active)
        return proc.pid

    def stop(self) -> bool:
        st = self.state()
        pid = st.get("pid")
        if not pid:
            return False
        try:
            os.kill(int(pid), signal.SIGTERM)
        except OSError:
            self._save(None, st.get("adapters", []), None)
            return False
        for _ in range(30):
            try:
                os.kill(int(pid), 0)
            except OSError:
                break
            self._sleep(1)
        self._save(None, st.get("adapters", []), None)
        return True

    def activate(self, adapter: str | None, adapters: Sequence[str], scale: float = 1.0) -> None:
        loaded = list_adapters(self.cfg.url, self._http)
        scales = [{"id": a["id"], "scale": (scale if adapter and adapter in str(a.get("path", "")) else 0.0)} for a in loaded]
        set_adapters(self.cfg.url, scales, self._http)

    # ---- swap ----------------------------------------------------------
    def swap(self, new_adapter: str, check: Callable[[], CheckResult], scale: float = 1.0) -> CheckResult:
        """Restart with ``new_adapter`` added, enable it, check, and roll back on failure."""
        prev = self.state()
        prev_adapters = [a for a in prev.get("adapters", []) if a != new_adapter]
        prev_active = prev.get("active")
        self.stop()
        try:
            self.start([new_adapter, *prev_adapters], active=new_adapter)
        except RuntimeError as e:
            self.start(prev_adapters, active=prev_active)
            return CheckResult(False, [], f"rolled back (restart): {e}")
        result = check()
        if result.ok:
            return result
        try:
            self.activate(prev_active, [new_adapter, *prev_adapters], scale)
            self._save(self.state().get("pid"), [new_adapter, *prev_adapters], prev_active)
            result.reason = "rolled back (scales): " + result.reason
        except Exception:
            self.stop()
            self.start(prev_adapters, active=prev_active)
            result.reason = "rolled back (restart): " + result.reason
        return result


def load_serve_config(path: str | Path | None) -> ServeConfig:
    cfg = ServeConfig()
    if path:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        for k, v in data.items():
            if hasattr(cfg, k):
                setattr(cfg, k, Path(v) if k == "state_path" else v)
    return cfg


def dump_serve_config(cfg: ServeConfig) -> str:
    d = asdict(cfg)
    d["state_path"] = str(cfg.state_path)
    return json.dumps(d, indent=2)
