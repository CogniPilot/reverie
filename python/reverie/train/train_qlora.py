"""QLoRA trainer (PEFT + bitsandbytes + TRL). Heavy imports happen inside ``train`` only.

Run inside the flake's dev shell:  ``python -m reverie.train train --config train.json``
``--dry-run`` prints the plan without importing torch.

The run is preemptible: it takes the ``train`` GPU lock (only after the GPU has been
idle for ``train_min_idle`` seconds), checkpoints every ``save_steps`` steps, stops at
the next step boundary when a higher-priority role asks for the GPU, and resumes from
the latest checkpoint on the next invocation.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from ..gpu import GpuLock
from .config import TrainConfig
from reverie import env_names


def plan(cfg: TrainConfig) -> dict:
    return {
        "base_model": cfg.base_model,
        "dataset": cfg.dataset_path,
        "output_dir": str(cfg.output_dir / "adapter"),
        "lora": {"r": cfg.lora_r, "alpha": cfg.lora_alpha, "dropout": cfg.lora_dropout, "targets": cfg.target_modules},
        "steps": cfg.max_steps,
        "seq_len": cfg.seq_len,
        "effective_batch": cfg.batch_size * cfg.grad_accum,
        "optim": cfg.optim,
        "save_steps": cfg.save_steps,
        "quantization": "4-bit nf4, bf16 compute" if cfg.bf16 else "4-bit nf4, fp16 compute",
        "resume_from": str(latest_checkpoint(cfg.output_dir / "checkpoints") or ""),
        "base_4bit_snapshot": str(cfg.base_4bit_dir) if snapshot_ready(cfg.base_4bit_dir) and snapshot_base(cfg.base_4bit_dir) == cfg.base_model else "",
    }


def latest_checkpoint(ckpt_dir: Path) -> Path | None:
    if not ckpt_dir.is_dir():
        return None
    cands = [p for p in ckpt_dir.glob("checkpoint-*") if p.is_dir() and p.name.split("-")[-1].isdigit()]
    if not cands:
        return None
    return max(cands, key=lambda p: int(p.name.split("-")[-1]))


MARKER = "snapshot-base.json"
LEGACY_MARKERS = tuple(filter(None, (env_names.lookup("REVERIE_SNAPSHOT_MARKER", ""),)))


def _marker(d: Path) -> Path | None:
    for name in (MARKER,) + LEGACY_MARKERS:
        if (d / name).exists():
            return d / name
    return None


def snapshot_ready(base_4bit_dir: str | Path) -> bool:
    """A saved nf4 snapshot exists and matches the base recorded in its marker."""
    d = Path(base_4bit_dir)
    return (d / "config.json").exists() and _marker(d) is not None


def snapshot_base(base_4bit_dir: str | Path) -> str:
    try:
        return json.loads(_marker(Path(base_4bit_dir)).read_text())["base_model"]
    except (AttributeError, OSError, ValueError, KeyError):
        return ""


def load_quantized(model_id: str, bf16: bool = True, gradient_checkpointing: bool = True,
                   base_4bit_dir: str | Path | None = None, prepare: bool = True):
    """The 4-bit base plus tokenizer, prepared for k-bit training.

    When ``base_4bit_dir`` holds a snapshot saved from ``model_id`` it is loaded instead of
    the bf16 weights, so the full download is needed only once.
    """
    import torch
    from peft import prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    if base_4bit_dir and snapshot_ready(base_4bit_dir) and snapshot_base(base_4bit_dir) == model_id:
        tok = AutoTokenizer.from_pretrained(str(base_4bit_dir))
        model = AutoModelForCausalLM.from_pretrained(str(base_4bit_dir), device_map={"": 0})
    else:
        compute = torch.bfloat16 if bf16 else torch.float16
        bnb = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=compute
        )
        tok = AutoTokenizer.from_pretrained(model_id)
        model = AutoModelForCausalLM.from_pretrained(model_id, quantization_config=bnb, device_map={"": 0})
    if prepare:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=gradient_checkpointing)
    return model, tok


def save_snapshot(model, tok, model_id: str, base_4bit_dir: str | Path) -> Path:
    """Serialise the nf4 weights so later runs skip the bf16 download (deletable afterwards)."""
    d = Path(base_4bit_dir)
    d.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(d))
    tok.save_pretrained(str(d))
    (d / MARKER).write_text(json.dumps({"base_model": model_id, "quant": "bnb-nf4", "saved_at": time.time()}))
    return d


def lora_config(cfg: TrainConfig):
    from peft import LoraConfig

    # attention and MLP projections only: convert_lora_to_gguf.py rejects embeddings and lm_head
    return LoraConfig(
        r=cfg.lora_r, lora_alpha=cfg.lora_alpha, lora_dropout=cfg.lora_dropout,
        target_modules=cfg.target_modules, task_type="CAUSAL_LM",
    )


def yield_callback(lock: GpuLock, state_path: Path):
    """A TrainerCallback that stops at the next step when the lock asks us to yield."""
    from transformers import TrainerCallback

    class YieldCallback(TrainerCallback):
        def on_step_end(self, args, state, control, **kwargs):
            if lock.should_yield():
                control.should_save = True
                control.should_training_stop = True
                state_path.write_text(json.dumps({"preempted_at_step": state.global_step, "at": time.time()}))
            return control

    return YieldCallback()


def train(cfg: TrainConfig, dry_run: bool = False) -> Path:
    out_dir = cfg.output_dir / "adapter"
    ckpt_dir = cfg.output_dir / "checkpoints"
    if dry_run:
        print(json.dumps(plan(cfg), indent=2))
        return out_dir

    lock = GpuLock("train")
    if not lock.acquire(timeout=0, min_idle=cfg.train_min_idle):
        raise SystemExit(f"GPU not available for training (needs {cfg.train_min_idle}s idle and a free lock)")
    try:
        import torch
        from datasets import load_dataset
        from trl import SFTConfig, SFTTrainer

        if not torch.cuda.is_available():
            raise SystemExit("CUDA is not available; QLoRA needs the GPU")
        model, tok = load_quantized(cfg.base_model, cfg.bf16, cfg.gradient_checkpointing, cfg.base_4bit_dir)
        ds = load_dataset("json", data_files=cfg.dataset_path, split="train")
        args = SFTConfig(
            output_dir=str(ckpt_dir),
            max_steps=cfg.max_steps,
            per_device_train_batch_size=cfg.batch_size,
            gradient_accumulation_steps=cfg.grad_accum,
            learning_rate=cfg.learning_rate,
            warmup_steps=cfg.warmup_steps,
            max_length=cfg.seq_len,
            bf16=cfg.bf16,
            optim=cfg.optim,
            logging_steps=5,
            save_strategy="steps",
            save_steps=cfg.save_steps,
            save_total_limit=2,
            seed=cfg.seed,
            gradient_checkpointing=cfg.gradient_checkpointing,
            report_to=[],
        )
        state_path = cfg.output_dir / "state.json"
        trainer = SFTTrainer(
            model=model, args=args, train_dataset=ds, processing_class=tok, peft_config=lora_config(cfg),
            callbacks=[yield_callback(lock, state_path)],
        )
        resume = latest_checkpoint(ckpt_dir)
        trainer.train(resume_from_checkpoint=str(resume) if resume else None)
        finished = trainer.state.global_step >= cfg.max_steps
        if finished:
            out_dir.mkdir(parents=True, exist_ok=True)
            trainer.model.save_pretrained(str(out_dir))
            tok.save_pretrained(str(out_dir))
        state_path.write_text(json.dumps({
            "finished": finished, "global_step": trainer.state.global_step, "at": time.time(), "plan": plan(cfg),
            "peak_vram_mib": int(torch.cuda.max_memory_allocated() / 2**20),
        }, indent=2), encoding="utf-8")
        return out_dir
    finally:
        lock.release()
