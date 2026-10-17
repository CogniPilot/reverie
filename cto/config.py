"""Paths, endpoints and tunables. Everything can be overridden with FLEET_* environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from .instance import Instance, load_instance

HOME = Path(os.environ.get("FLEET_HOME", Path.home()))
CACHE = HOME / ".cache"
DATA_DIR = Path(os.environ.get("FLEET_DATA_DIR", HOME / ".local" / "share" / "agent-fleet" / "default"))


DEPRECATIONS: list[str] = []


def _env_fallback(new: str, old: str, default: str = "") -> str:
    """Read ``new`` from the environment, falling back to the deprecated ``old`` name."""
    if os.environ.get(new):
        return os.environ[new]
    if os.environ.get(old):
        DEPRECATIONS.append(f"{old} is deprecated, use {new}")
        return os.environ[old]
    return default


def _path_fallback(env: str, new: Path, old: Path) -> Path:
    """Prefer ``env``, then ``new`` if it exists, then the deprecated ``old`` if it exists."""
    if os.environ.get(env):
        return Path(os.environ[env])
    if new.exists() or not old.exists():
        return new
    DEPRECATIONS.append(f"{old} is deprecated, move it to {new}")
    return old


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Config:
    instance_config: Path | None = field(default_factory=lambda: (
        Path(os.environ["FLEET_INSTANCE_CONFIG"]) if os.environ.get("FLEET_INSTANCE_CONFIG") else None))
    instance: Instance | None = field(default=None, init=False, repr=False)
    # llama-server router (one model loaded at a time)
    api_base: str = os.environ.get("FLEET_API_BASE", "http://127.0.0.1:8080/v1")
    model: str = field(default_factory=lambda: _env_fallback("FLEET_MODEL", "JESTER_MODEL", "qwen3.8-27b"))
    request_timeout: int = _env_int("FLEET_TIMEOUT", 240)

    # optional CPU embedding server (a second llama-server started with --embeddings);
    # empty means the pure-Python hashed embedder is used
    embed_url: str = os.environ.get("FLEET_EMBED_URL", "")
    embed_model: str = os.environ.get("FLEET_EMBED_MODEL", "")
    embed_dims: int = _env_int("FLEET_EMBED_DIMS", 1024)
    embed_doc_prefix: str = os.environ.get("FLEET_EMBED_DOC_PREFIX", "search_document: ")
    embed_query_prefix: str = os.environ.get("FLEET_EMBED_QUERY_PREFIX", "search_query: ")

    # GPU lock (see cto.gpu); chat waits at most this long for a lower-priority holder to yield
    gpu_lock_wait: int = _env_int("FLEET_GPU_LOCK_WAIT", 90)
    gpu_lock_path: Path = Path(os.environ.get("FLEET_GPU_LOCK", CACHE / "gpu.lock"))
    gpu_yield_path: Path = Path(os.environ.get("FLEET_GPU_YIELD", CACHE / "gpu.yield"))
    gpu_activity_path: Path = Path(os.environ.get("FLEET_GPU_ACTIVITY", CACHE / "gpu.activity"))

    # files
    data_dir: Path = DATA_DIR
    db_path: Path = field(default_factory=lambda: DATA_DIR / "memory.sqlite")
    profile_path: Path = field(default_factory=lambda: DATA_DIR / "profile.md")
    persona_path: Path = field(default_factory=lambda: Path(os.environ.get("FLEET_PERSONA", DATA_DIR / "persona.txt")))
    legacy_history: Path = Path(os.environ.get("FLEET_LEGACY_HISTORY", DATA_DIR / "legacy-history.json"))
    hold_path: Path = Path(os.environ.get("FLEET_HOLD", CACHE / "cto.hold"))
    legacy_hold_path: Path = DATA_DIR / "legacy.hold"            # still honoured, with a deprecation line
    log_path: Path = Path(os.environ.get("FLEET_LOG", CACHE / "cto.log"))

    # memory
    short_term_turns: int = _env_int("FLEET_SHORT_TERM_TURNS", 20)   # exchanges kept verbatim in context
    recall_k: int = _env_int("FLEET_RECALL_K", 6)                    # memories injected per turn
    recency_decay_per_hour: float = _env_float("FLEET_RECENCY_DECAY", 0.995)
    default_importance: float = 3.0
    joke_importance: float = 2.0
    profile_max_chars: int = 2000

    # daemon timing (seconds)
    poll_interval: int = _env_int("FLEET_POLL", 10)
    joke_interval: int = field(default_factory=lambda: int(_env_fallback("FLEET_INTERVAL", "JESTER_INTERVAL", "240") or 240))
    reflect_interval: int = _env_int("FLEET_REFLECT_INTERVAL", 1800)
    reflect_min_episodes: int = _env_int("FLEET_REFLECT_MIN_EPISODES", 3)
    rate_batch: int = 3                                              # importance ratings per idle pass

    # dreams (see cto.dream): only in the sleep window, i.e. no user activity for sleep_min_idle seconds
    sleep_min_idle: int = _env_int("FLEET_SLEEP_MIN_IDLE", 1800)
    dreams_per_sleep: int = _env_int("FLEET_DREAMS_PER_SLEEP", 1)
    dream_spacing: int = _env_int("FLEET_DREAM_SPACING", 3600)
    dream_mood_weight: float = _env_float("FLEET_DREAM_MOOD_WEIGHT", 1.0)
    dream_recall_hours: float = _env_float("FLEET_DREAM_RECALL_HOURS", 24.0)   # how long the last dream stays in the prompt
    dream_prompt_path: Path = Path(os.environ.get("FLEET_DREAM_PROMPT", DATA_DIR / "dream-prompt.txt"))

    # generation: the persona governs reply length; these are safety caps, not targets
    reply_max_tokens: int = _env_int("FLEET_REPLY_MAX_TOKENS", 400)
    reply_temperature: float = 0.9
    reply_max_words: int = _env_int("FLEET_REPLY_MAX_WORDS", 150)        # 0 disables the trim
    reply_max_chars: int = _env_int("FLEET_REPLY_MAX_CHARS", 1200)
    voice_reply_max_tokens: int = _env_int("FLEET_VOICE_REPLY_MAX_TOKENS", 600)
    voice_reply_max_words: int = _env_int("FLEET_VOICE_REPLY_MAX_WORDS", 0)  # spoken replies are never cut

    session_id: str = os.environ.get("CODEMAN_SESSION_ID", "")

    def __post_init__(self) -> None:
        if self.instance_config is None:
            return
        self.instance_config = self.instance_config.expanduser().resolve(strict=True)
        self.instance = load_instance(self.instance_config)
        # Explicit instances never fall back to personal caches, profiles or history.
        self.data_dir = self.instance.data_dir
        self.db_path = self.data_dir / "memory.sqlite"
        self.profile_path = self.data_dir / "profile.md"
        self.persona_path = self.data_dir / "persona.txt"
        self.dream_prompt_path = self.data_dir / "dream-prompt.txt"
        self.legacy_history = self.data_dir / "legacy-history.json"
        self.hold_path = self.data_dir / "maintenance.hold"
        self.legacy_hold_path = self.data_dir / "legacy.hold"
        self.log_path = self.data_dir / "logs" / "runtime.log"

    def deprecations(self) -> list[str]:
        return list(DEPRECATIONS)

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
