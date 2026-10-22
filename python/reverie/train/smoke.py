"""Phase 2 step 0: a QLoRA feasibility smoke test on the chosen base (do not run casually).

Loads the base in 4-bit NF4, attaches a rank-16 LoRA on attention and MLP projections,
and trains 20 steps at sequence length 1024, batch 1, gradient checkpointing and paged
8-bit AdamW on persona text. It records peak VRAM, tokens per second and wall time to
``<output_root>/smoke/<run>/report.json``. ``--plan`` only prints what the run needs.
"""
from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

from ..gpu import GpuLock
from .config import TrainConfig
from .train_qlora import snapshot_ready

SMOKE_STEPS = 20
SMOKE_SEQ = 1024


def hf_home() -> Path:
    """Hugging Face cache: ``HF_HOME`` if set, else ``~/.cache/huggingface`` on the root disk."""
    env = os.environ.get("HF_HOME")
    if env:
        return Path(env)
    return Path.home() / ".cache" / "huggingface"


def requirements(cfg: TrainConfig) -> dict:
    """What the smoke run needs, before anything is downloaded."""
    home = hf_home()
    params_b = 27.0 if "27B" in cfg.base_model else (9.0 if "9B" in cfg.base_model else 0.0)
    weights_gb = round(params_b * 2.0, 1)                       # bf16 safetensors
    usage = shutil.disk_usage(home if home.exists() else home.parent if home.parent.exists() else Path.home())
    return {
        "base_model": cfg.base_model,
        "hf_home": str(home),
        "download_gb_estimate": weights_gb,
        "free_gb_at_hf_home": round(usage.free / 2**30, 1),
        "vram_estimate_gb": {"4bit_weights": round(params_b * 0.55, 1), "lora_and_activations_at_1k": 4.0, "total": round(params_b * 0.55 + 4.0, 1)},
        "steps": SMOKE_STEPS,
        "seq_len": SMOKE_SEQ,
        "expected_minutes": {"download": "20-60 at 20-50 MB/s", "load": "3-6", "train": "5-15"},
        "min_idle_seconds": cfg.train_min_idle,
        "base_4bit_snapshot": str(cfg.base_4bit_dir),
        "snapshot_present": snapshot_ready(cfg.base_4bit_dir),
    }


def persona_text(n_chars: int = 40000) -> str:
    """Persona and memory text for the synthetic training rows and perplexity probes."""
    from ..config import Config
    from ..memory import EPISODE, MemoryStore
    from ..persona import load_persona, read_profile

    c = Config()
    parts = [load_persona(c.persona_path), read_profile(c.profile_path)]
    try:
        store = MemoryStore(c.db_path)
        parts += [m.text for m in store.all(EPISODE)]
    except Exception:
        pass
    return "\n\n".join(p for p in parts if p)[:n_chars]


def run(cfg: TrainConfig, plan_only: bool = False) -> dict:
    req = requirements(cfg)
    if plan_only:
        return req
    os.environ.setdefault("HF_HOME", req["hf_home"])
    lock = GpuLock("train")
    if not lock.acquire(timeout=0, min_idle=cfg.train_min_idle):
        raise SystemExit("GPU not available: the lock is held or it has not been idle long enough")
    try:
        import torch
        from datasets import Dataset
        from trl import SFTConfig, SFTTrainer

        from .train_qlora import load_quantized, lora_config, save_snapshot, snapshot_base, snapshot_ready

        out = Path(cfg.output_root) / "smoke" / time.strftime("%Y%m%d-%H%M%S")
        out.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        had_snapshot = snapshot_ready(cfg.base_4bit_dir) and snapshot_base(cfg.base_4bit_dir) == cfg.base_model
        model, tok = load_quantized(cfg.base_model, True, True, cfg.base_4bit_dir, prepare=False)
        load_s = time.time() - t0
        snapshot_s = 0.0
        if not had_snapshot:
            t0 = time.time()
            save_snapshot(model, tok, cfg.base_model, cfg.base_4bit_dir)
            snapshot_s = time.time() - t0
        from peft import prepare_model_for_kbit_training

        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
        text = persona_text()
        rows = [{"text": text[i:i + 4000]} for i in range(0, max(len(text), 4000), 2000)][:64] or [{"text": "CTO."}]
        ds = Dataset.from_list(rows)
        args = SFTConfig(
            output_dir=str(out / "checkpoints"), max_steps=SMOKE_STEPS, per_device_train_batch_size=1,
            gradient_accumulation_steps=1, learning_rate=cfg.learning_rate, max_length=SMOKE_SEQ, bf16=True,
            optim="paged_adamw_8bit", gradient_checkpointing=True, logging_steps=1, save_strategy="no",
            report_to=[], seed=cfg.seed,
        )
        trainer = SFTTrainer(model=model, args=args, train_dataset=ds, processing_class=tok, peft_config=lora_config(cfg))
        torch.cuda.reset_peak_memory_stats()
        t1 = time.time()
        result = trainer.train()
        train_s = time.time() - t1
        report = {
            "base_model": cfg.base_model,
            "steps": SMOKE_STEPS, "seq_len": SMOKE_SEQ,
            "load_seconds": round(load_s, 1), "train_seconds": round(train_s, 1),
            "loaded_from_snapshot": had_snapshot, "snapshot_dir": str(cfg.base_4bit_dir), "snapshot_seconds": round(snapshot_s, 1),
            "tokens_per_second": round(SMOKE_STEPS * SMOKE_SEQ / train_s, 1),
            "peak_vram_mib": int(torch.cuda.max_memory_allocated() / 2**20),
            "reserved_vram_mib": int(torch.cuda.max_memory_reserved() / 2**20),
            "train_loss": getattr(result, "training_loss", None),
            "requirements": req,
        }
        (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        return report
    finally:
        lock.release()
