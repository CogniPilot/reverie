"""Initial recurring specialists; private histories are created locally, never bundled."""
from __future__ import annotations

import json
from pathlib import Path

from cto.config import Config
from cto.fleet import Fleet
from cto.memory import MemoryStore

PERSONAS = {
    "compiler": {"name": "Compiler specialist", "role": "Compiler engineer",
             "personality": "Methodical, candid and curious. Values clear semantics, small reproducers and measured compiler changes.",
             "projects": []},
    "app": {"name": "Application specialist", "role": "WASM and application engineer",
            "personality": "Practical, inventive and direct. Follows the bytes, profiles real workloads and cares about usable interfaces.",
            "projects": []},
    "math": {"name": "Mathematics specialist", "role": "Mathematician and formal reasoning specialist",
              "personality": "Patient, inquisitive and precise. Enjoys unusual connections, asks for assumptions and searches for counterexamples.",
              "projects": []},
    "controls": {"name": "Controls specialist", "role": "Control engineering and estimation specialist",
               "personality": "Thoughtful, skeptical and creative. Checks units, physical meaning, observability and evidence from experiments.",
               "projects": []},
}


def initialize(cfg: Config | None = None) -> list[dict]:
    cfg = cfg or Config()
    cfg.ensure_dirs()
    root_store = MemoryStore(cfg.db_path)
    try:
        fleet = Fleet(root_store)
        records = []
        for identifier, definition in PERSONAS.items():
            private = cfg.data_dir / "agents" / identifier
            private.mkdir(parents=True, exist_ok=True, mode=0o700)
            store = MemoryStore(private / "memory.sqlite")
            store.close()
            profile = {**definition, "id": identifier, "persistent": True, "dreaming": False,
                       "private_memory": str(private / "memory.sqlite"),
                       "project_memory": "Explicit lookup in the project-wide store; never copy personal DM history.",
                       "short_term": "No active assignment. CTO selects a bounded task after checking priorities and capacity.",
                       "long_term": "Personal lessons stay private; shared project findings use explicit project lookup.",
                       "memory_queries": definition["projects"]}
            path = private / "persona.json"
            if not path.exists():
                path.write_text(json.dumps(profile, indent=2) + "\n")
                path.chmod(0o600)
            # Existing profiles preserve their current handoff and any authored personality.
            previous = fleet.profiles().get(identifier)
            if previous:
                updated = {**profile, **previous["body"]}
                for key in ("name", "personality", "private_memory", "projects"):
                    updated.setdefault(key, profile[key])
                fleet.save_profile(identifier, updated, previous["revision"])
            else:
                fleet.save_profile(identifier, profile, 0)
            records.append({"id": identifier, "name": definition["name"], "role": definition["role"],
                            "private_memory": str(private / "memory.sqlite"), "running": False})
        return records
    finally:
        root_store.close()


if __name__ == "__main__":
    print(json.dumps(initialize(), indent=2))
