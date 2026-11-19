"""Paths, endpoints and tunables. Everything can be overridden with REVERIE_* environment variables."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from .hands.agent_journal import (
    TURN_CAPTURE_BYTES, encode_memory_json, legacy_memory_request, native_memory_json, native_memory_output,
)
from .instance import Instance, load_instance
from reverie import env_names

HOME = Path(env_names.lookup("REVERIE_HOME", Path.home()))
ROOT = Path(env_names.lookup("REVERIE_ROOT", HOME / "reverie"))
CACHE = ROOT / "scratch" / "cache"
DATA_DIR = Path(env_names.lookup("REVERIE_DATA_DIR", ROOT / "companies" / "default" / "data"))


DEPRECATIONS: list[str] = []


class LLMError(RuntimeError):
    pass


def model_completion(url, body, timeout, key_env=None):
    frame = encode_memory_json({
        "action": "complete", "url": url, "body": body.decode("ascii"),
        "timeout": timeout, "key_env": key_env,
    })
    if frame is not None:
        response = native_memory_output("model-completion-worker", frame, TURN_CAPTURE_BYTES, timeout=timeout + 3)
        if response is not None:
            return response
    raise LLMError("chat request failed at the native model endpoint")


def _format_reply(action, text, limit):
    if not isinstance(text, str):
        raise LLMError("model completion content must be text")
    response = native_memory_json("model-completion-worker", {
        "action": action, "points": list(map(ord, text)), "limit": limit,
    }, TURN_CAPTURE_BYTES)
    if response is None:
        raise LLMError("native model reply formatting failed")
    return "".join(map(chr, response["points"]))


def limit_words(text, max_words):
    return _format_reply("limit_words", text, max_words)


class ChatClient:
    """Compatibility binding for callers that still own model request orchestration."""

    def __init__(self, api_base, model, timeout=240, transport=None):
        self.api_base = api_base.rstrip("/")
        self.model = model
        self.timeout = timeout
        self._transport = transport or model_completion

    def chat(self, messages, max_tokens=220, temperature=0.9, max_chars=600, extra=None):
        body = {
            "model": self.model,
            "messages": list(messages),
            "max_tokens": max_tokens,
            "temperature": temperature,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        if extra:
            body.update(extra)
        try:
            raw = self._transport(self.api_base + "/chat/completions", json.dumps(body).encode(), self.timeout)
            content = json.loads(raw)["choices"][0]["message"].get("content") or ""
        except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
            raise LLMError("chat request returned an invalid completion") from error
        return _format_reply("clean", content, max_chars)

    def rate(self, text, default=3.0):
        prompt = legacy_memory_request("rating_prompt")
        if prompt is None:
            return default
        messages = [
            {"role": "system", "content": prompt["system"]},
            {"role": "user", "content": text + prompt["suffix"]},
        ]
        try:
            reply = self.chat(messages, max_tokens=prompt["max_tokens"],
                              temperature=prompt["temperature"], max_chars=prompt["max_chars"])
        except LLMError:
            return default
        result = legacy_memory_request("rating_score", points=list(map(ord, reply)))
        return float(result["score"]) if result and result["score"] is not None else default


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
        return int(env_names.lookup(name, default))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(env_names.lookup(name, default))
    except ValueError:
        return default


@dataclass
class Config:
    instance_config: Path | None = field(default_factory=lambda: (
        Path(env_names.require("REVERIE_INSTANCE_CONFIG")) if env_names.lookup("REVERIE_INSTANCE_CONFIG") else None))
    instance: Instance | None = field(default=None, init=False, repr=False)
    # llama-server router (one model loaded at a time)
    api_base: str = env_names.lookup("REVERIE_API_BASE", "http://127.0.0.1:8080/v1")
    model: str = field(default_factory=lambda: (env_names.lookup("REVERIE_MODEL") or "MODEL_ID"))
    request_timeout: int = _env_int("REVERIE_TIMEOUT", 240)

    # optional CPU embedding server (a second llama-server started with --embeddings);
    # empty means the pure-Python hashed embedder is used
    embed_url: str = env_names.lookup("REVERIE_EMBED_URL", "")
    embed_model: str = env_names.lookup("REVERIE_EMBED_MODEL", "")
    embed_dims: int = _env_int("REVERIE_EMBED_DIMS", 1024)
    embed_doc_prefix: str = env_names.lookup("REVERIE_EMBED_DOC_PREFIX", "search_document: ")
    embed_query_prefix: str = env_names.lookup("REVERIE_EMBED_QUERY_PREFIX", "search_query: ")

    # GPU lock (see reverie.gpu); chat waits at most this long for a lower-priority holder to yield
    gpu_lock_wait: int = _env_int("REVERIE_GPU_LOCK_WAIT", 90)
    gpu_lock_path: Path = Path(env_names.lookup("REVERIE_GPU_LOCK", CACHE / "gpu.lock"))
    gpu_yield_path: Path = Path(env_names.lookup("REVERIE_GPU_YIELD", CACHE / "gpu.yield"))
    gpu_activity_path: Path = Path(env_names.lookup("REVERIE_GPU_ACTIVITY", CACHE / "gpu.activity"))

    # files
    data_dir: Path = DATA_DIR
    db_path: Path = field(default_factory=lambda: DATA_DIR / "memory.sqlite")
    profile_path: Path = field(default_factory=lambda: DATA_DIR / "profile.md")
    persona_path: Path = field(default_factory=lambda: Path(env_names.lookup("REVERIE_PERSONA", DATA_DIR / "persona.txt")))
    legacy_history: Path = Path(env_names.lookup("REVERIE_LEGACY_HISTORY", DATA_DIR / "legacy-history.json"))
    hold_path: Path = Path(env_names.lookup("REVERIE_HOLD", CACHE / "reverie.hold"))
    legacy_hold_path: Path = DATA_DIR / "legacy.hold"            # still honoured, with a deprecation line
    log_path: Path = Path(env_names.lookup("REVERIE_LOG", CACHE / "reverie.log"))

    # memory
    short_term_turns: int = _env_int("REVERIE_SHORT_TERM_TURNS", 20)   # exchanges kept verbatim in context
    recall_k: int = _env_int("REVERIE_RECALL_K", 6)                    # memories injected per turn
    recency_decay_per_hour: float = _env_float("REVERIE_RECENCY_DECAY", 0.995)
    default_importance: float = 3.0
    joke_importance: float = 2.0
    profile_max_chars: int = 2000

    # daemon timing (seconds)
    poll_interval: int = _env_int("REVERIE_POLL", 10)
    joke_interval: int = field(default_factory=lambda: _env_int("REVERIE_INTERVAL", 240))
    reflect_interval: int = _env_int("REVERIE_REFLECT_INTERVAL", 1800)
    reflect_min_episodes: int = _env_int("REVERIE_REFLECT_MIN_EPISODES", 3)
    rate_batch: int = 3                                              # importance ratings per idle pass

    # dreams: only in the sleep window, i.e. no user activity for sleep_min_idle seconds
    sleep_min_idle: int = _env_int("REVERIE_SLEEP_MIN_IDLE", 1800)
    dreams_per_sleep: int = _env_int("REVERIE_DREAMS_PER_SLEEP", 0)   # off unless the owner turns it on
    dream_spacing: int = _env_int("REVERIE_DREAM_SPACING", 3600)
    dream_mood_weight: float = _env_float("REVERIE_DREAM_MOOD_WEIGHT", 1.0)
    dream_recall_hours: float = _env_float("REVERIE_DREAM_RECALL_HOURS", 24.0)   # how long the last dream stays in the prompt
    dream_prompt_path: Path = Path(env_names.lookup("REVERIE_DREAM_PROMPT", DATA_DIR / "dream-prompt.txt"))

    # generation: the persona governs reply length; these are safety caps, not targets
    reply_max_tokens: int = _env_int("REVERIE_REPLY_MAX_TOKENS", 400)
    reply_temperature: float = 0.9
    reply_max_words: int = _env_int("REVERIE_REPLY_MAX_WORDS", 150)        # 0 disables the trim
    reply_max_chars: int = _env_int("REVERIE_REPLY_MAX_CHARS", 1200)

    session_id: str = os.environ.get("REVERIE_SESSION_ID", "")

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
