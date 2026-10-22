"""4-bit versus 16-bit perplexity of the base on persona text (phase 2 step 0, do not run casually).

The 16-bit pass of a 27B model does not fit in 24 GB, so it runs with ``device_map="auto"``
and the remainder of the weights offloaded to CPU RAM (slow, but a one-off over a few
thousand tokens). Results go to ``<output_root>/perplexity/<timestamp>.json``.
"""
from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path

from ..gpu import GpuLock
from .config import TrainConfig
from .smoke import hf_home, persona_text
from .train_qlora import load_quantized


def _perplexity(model, tok, text: str, max_len: int = 1024, stride: int = 512) -> float:
    import torch

    enc = tok(text, return_tensors="pt")
    ids = enc.input_ids
    nll, count = 0.0, 0
    prev_end = 0
    device = next(model.parameters()).device
    for begin in range(0, ids.size(1), stride):
        end = min(begin + max_len, ids.size(1))
        target_len = end - prev_end
        chunk = ids[:, begin:end].to(device)
        labels = chunk.clone()
        labels[:, :-target_len] = -100
        with torch.no_grad():
            out = model(chunk, labels=labels)
        nll += float(out.loss) * target_len
        count += target_len
        prev_end = end
        if end == ids.size(1):
            break
    return math.exp(nll / max(1, count))


def bf16_available(model_id: str) -> bool:
    """True when the bf16 safetensors are in the local HF cache (no download is attempted)."""
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(model_id, local_files_only=True, allow_patterns=["*.safetensors", "*.json"])
        return True
    except Exception:
        return False


def run(cfg: TrainConfig, n_chars: int = 12000, gpu_budget_gib: int = 21) -> dict:
    os.environ.setdefault("HF_HOME", str(hf_home()))
    lock = GpuLock("train")
    if not lock.acquire(timeout=0, min_idle=cfg.train_min_idle):
        raise SystemExit("GPU not available: the lock is held or it has not been idle long enough")
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        text = persona_text(n_chars)
        tok = AutoTokenizer.from_pretrained(cfg.base_model)
        report: dict = {"base_model": cfg.base_model, "chars": len(text), "tokens": int(tok(text, return_tensors="pt").input_ids.size(1))}

        t0 = time.time()
        m4, _ = load_quantized(cfg.base_model, True, False, cfg.base_4bit_dir, prepare=False)
        report["ppl_4bit"] = round(_perplexity(m4, tok, text), 3)
        report["seconds_4bit"] = round(time.time() - t0, 1)
        del m4
        torch.cuda.empty_cache()

        t0 = time.time()
        if bf16_available(cfg.base_model):
            offload = Path(cfg.output_root) / "perplexity" / "offload"
            offload.mkdir(parents=True, exist_ok=True)
            m16 = AutoModelForCausalLM.from_pretrained(
                cfg.base_model, dtype=torch.bfloat16, device_map="auto",
                max_memory={0: f"{gpu_budget_gib}GiB", "cpu": "40GiB"}, offload_folder=str(offload),
            )
            report["ppl_16bit"] = round(_perplexity(m16, tok, text), 3)
            report["seconds_16bit"] = round(time.time() - t0, 1)
            report["ratio_4bit_over_16bit"] = round(report["ppl_4bit"] / report["ppl_16bit"], 4)
            del m16
        else:
            report["ppl_16bit"] = None
            report["note"] = "bf16 weights not in the HF cache (deleted after the 4-bit snapshot?); only the 4-bit pass ran"

        out = Path(cfg.output_root) / "perplexity" / (time.strftime("%Y%m%d-%H%M%S") + ".json")
        out.write_text(json.dumps(report, indent=2), encoding="utf-8")
        report["path"] = str(out)
        return report
    finally:
        lock.release()
