"""Owner-selected instance data. No credentials or conversation history belong here."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
import re
from copy import deepcopy


@dataclass(frozen=True)
class Instance:
    id: str
    agent_name: str
    owner_name: str
    data_dir: Path
    persona: str
    initial_self: dict | None = None
    role: str = "CTO"
    kind: str = "cto"
    shared_room_tone: str = "professional"  # owner-selected: "professional", or "social" (social in chat, professional in coding)
    employee_id: str | None = None  # the console company employee this instance belongs to (checked by hooks)


def load_instance(path: Path) -> Instance:
    path = path.expanduser().resolve(strict=True)
    return parse_instance(path.read_text(encoding="utf-8"), path)


def parse_instance(text: str, path: Path) -> Instance:
    """Validate instance config text already read from the resolved path (which places a relative data_dir)."""
    raw = json.loads(text)
    allowed = {"id", "agent_name", "owner_name", "data_dir", "persona", "initial_self", "role", "kind", "shared_room_tone",
               "employee_id"}
    if not isinstance(raw, dict) or set(raw) - allowed:
        raise ValueError("instance config must be an object with supported fields only")
    for key in ("id", "agent_name", "owner_name", "data_dir", "persona"):
        if not isinstance(raw.get(key), str) or not raw[key].strip():
            raise ValueError(f"instance config requires nonempty {key}")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", raw["id"]):
        raise ValueError("invalid instance id")
    state = Path(raw["data_dir"]).expanduser()
    if not state.is_absolute():
        state = path.parent / state
    state = state.resolve()
    if state == path.parent or state in path.parents:
        raise ValueError("instance data_dir must be a separate state directory")
    initial = raw.get("initial_self")
    if initial is not None and (not isinstance(initial, dict) or
            not isinstance(initial.get("consciousness"), str) or
            not isinstance(initial.get("directives"), list) or
            any(not isinstance(item, str) or not item.strip() for item in initial["directives"])):
        raise ValueError("initial_self requires a consciousness statement and directive strings")
    if raw.get("kind", "cto") not in ("cto", "agent", "expert", "implementer"):
        raise ValueError("invalid agent kind")
    if not isinstance(raw.get("role", "CTO"), str) or not raw.get("role", "CTO").strip():
        raise ValueError("role must be nonempty text")
    if raw.get("shared_room_tone", "professional") not in ("professional", "social"):
        raise ValueError("shared_room_tone must be professional or social")
    if "employee_id" in raw and not (isinstance(raw["employee_id"], str) and
                                     re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", raw["employee_id"])):
        raise ValueError("employee_id must be a lowercase UUID")
    return Instance(raw["id"], raw["agent_name"], raw["owner_name"], state, raw["persona"], initial, raw.get("role", "CTO"),
                    raw.get("kind", "cto"), raw.get("shared_room_tone", "professional"),
                    raw.get("employee_id"))


def initial_self_for(instance: Instance | None) -> dict | None:
    if instance is None:
        return None
    from .fleet import INITIAL_SELF
    model = deepcopy(INITIAL_SELF)
    model.update(instance.initial_self or {})
    model["persona"] = instance.persona
    model["reason"] = "Initial commitments from the owner-selected instance configuration."
    return model


def identity_context(instance: Instance | None) -> str:
    if instance is None:
        return ""
    return f"Instance: {instance.id}. Your name is {instance.agent_name}. Your owner is {instance.owner_name}. Your role is {instance.role}."


def primary_agent(instance: Instance | None) -> str:
    """Choose a harness profile independently of organizational authority."""
    return "chat" if instance is not None and instance.kind == "agent" else "cto"
