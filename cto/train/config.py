"""Training configuration (JSON file, all fields optional)."""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

from ..config import DATA_DIR

# Public candidate bases; select base_model explicitly in the training JSON.
BASE_CANDIDATES = (
    "huihui-ai/Huihui-Qwen3.8-27B-abliterated",
    "Qwen/Qwen3.8-27B",
    "Qwen/Qwen3.5-9B",
)


@dataclass
class TrainConfig:
    base_model: str = "MODEL_ID"              # owner-selected public model or local snapshot
    base_model_dir: str = ""                 # local HF snapshot used by convert; empty means resolve from the cache
    base_4bit_dir: str = str(Path.home() / "scratch" / "agent-fleet" / "training" / "base-4bit")   # saved nf4 snapshot, preferred when present
    run_name: str = "agent-fleet"
    output_root: str = str(DATA_DIR / "adapters")
    dataset_path: str = str(DATA_DIR / "datasets" / "latest.jsonl")

    # LoRA
    lora_r: int = 16
    lora_alpha: int = 32
    lora_dropout: float = 0.05
    target_modules: list[str] = field(default_factory=lambda: ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])

    # optimisation
    max_steps: int = 200
    seq_len: int = 2048
    learning_rate: float = 2e-4
    batch_size: int = 1
    grad_accum: int = 8
    warmup_steps: int = 10
    seed: int = 0
    bf16: bool = True
    gradient_checkpointing: bool = True
    optim: str = "paged_adamw_8bit"
    save_steps: int = 5                      # checkpoint cadence, so a preempted run resumes cheaply
    train_min_idle: int = 1800               # seconds the GPU must have been idle before training starts

    # dataset building
    min_importance: float = 3.0              # episodes below this are never exported
    sample_size: int = 400                   # importance-weighted draws from the recent window
    replay_size: int = 100                   # uniform draws from older material (anti-forgetting)
    recent_days: float = 1.0                 # the "day's conversations" window
    include_reflections: bool = True
    include_idle: bool = False
    include_dreams: bool = False             # released dreams only, as style data at weight 0.1, never facts

    # conversion and serving
    llama_cpp_dir: str = os.environ.get("LLAMA_CPP_DIR", str(Path.home() / "git" / "llama.cpp"))
    server_url: str = "http://127.0.0.1:8080"
    adapter_scale: float = 1.0
    keep_versions: int = 5

    @property
    def output_dir(self) -> Path:
        return Path(self.output_root) / self.run_name

    @classmethod
    def load(cls, path: str | Path | None) -> "TrainConfig":
        cfg = cls()
        if not path:
            return cfg
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        known = {f.name for f in fields(cls)}
        for k, v in data.items():
            if k in known:
                setattr(cfg, k, v)
        return cfg

    def dump(self) -> str:
        return json.dumps(asdict(self), indent=2)
