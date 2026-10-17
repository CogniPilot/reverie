"""Convert a PEFT adapter directory to a GGUF LoRA with llama.cpp's convert_lora_to_gguf.py.

The nix llama-cpp package ships binaries only; point ``llama_cpp_dir`` at a source
checkout (``git clone https://github.com/ggml-org/llama.cpp`` or
``nix build nixpkgs#llama-cpp.src``). Versioned outputs land under
``<output_root>/<run_name>/gguf/adapter-<timestamp>.gguf`` with a ``latest`` symlink.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

from .config import TrainConfig


def convert_script(cfg: TrainConfig) -> Path:
    p = Path(cfg.llama_cpp_dir) / "convert_lora_to_gguf.py"
    if not p.exists():
        raise FileNotFoundError(f"convert_lora_to_gguf.py not found under {cfg.llama_cpp_dir}; set llama_cpp_dir")
    return p


def convert(cfg: TrainConfig, adapter_dir: Path | None = None, runner=subprocess.run) -> Path:
    adapter_dir = adapter_dir or (cfg.output_dir / "adapter")
    gguf_dir = cfg.output_dir / "gguf"
    gguf_dir.mkdir(parents=True, exist_ok=True)
    out = gguf_dir / f"adapter-{time.strftime('%Y%m%d-%H%M%S')}.gguf"
    cmd = [sys.executable, str(convert_script(cfg)), "--outfile", str(out), "--outtype", "f16"]
    if cfg.base_model_dir:
        cmd += ["--base", cfg.base_model_dir]
    else:
        cmd += ["--base-model-id", cfg.base_model]
    cmd.append(str(adapter_dir))
    runner(cmd, check=True)
    latest = gguf_dir / "latest.gguf"
    if latest.is_symlink() or latest.exists():
        latest.unlink()
    os.symlink(out.name, latest)
    prune(gguf_dir, cfg.keep_versions)
    return out


def prune(gguf_dir: Path, keep: int) -> list[Path]:
    files = sorted(gguf_dir.glob("adapter-*.gguf"))
    removed = []
    for p in files[:-keep] if keep > 0 else []:
        p.unlink()
        removed.append(p)
    return removed
