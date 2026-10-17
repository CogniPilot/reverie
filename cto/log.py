"""Append-only log at ~/.cache/cto.log, with a stderr mirror when not running under the daemon."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

_configured = False


def setup(path: Path, level: int = logging.INFO, stderr: bool = False) -> logging.Logger:
    global _configured
    log = logging.getLogger("fleet")
    if _configured:
        return log
    log.setLevel(level)
    fmt = logging.Formatter("%(asctime)s %(levelname).1s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(path, encoding="utf-8")
    fh.setFormatter(fmt)
    log.addHandler(fh)
    if stderr:
        sh = logging.StreamHandler(sys.stderr)
        sh.setFormatter(fmt)
        log.addHandler(sh)
    _configured = True
    return log


def get(name: str = "fleet") -> logging.Logger:
    return logging.getLogger(name)
