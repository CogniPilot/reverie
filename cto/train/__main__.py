"""CLI: python -m cto.train {dataset,train,convert,swap,plan} [--config train.json]"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ..beliefs import ensure_seeded, render
from ..config import Config
from ..memory import MemoryStore
from ..persona import build_system_prompt, load_persona, read_profile
from .config import BASE_CANDIDATES, TrainConfig


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m cto.train")
    p.add_argument("--config", help="JSON file with TrainConfig fields")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("plan", help="print the effective configuration")
    d = sub.add_parser("dataset", help="export an importance-weighted JSONL dataset from memory")
    d.add_argument("--out")
    t = sub.add_parser("train", help="run QLoRA (needs the flake dev shell and the GPU)")
    t.add_argument("--dry-run", action="store_true")
    c = sub.add_parser("convert", help="convert the PEFT adapter to GGUF")
    c.add_argument("--adapter-dir")
    s = sub.add_parser("swap", help="enable a loaded GGUF adapter on llama-server by scale, with rollback")
    s.add_argument("--adapter", default="latest.gguf", help="substring of the adapter path, or its id")
    sm = sub.add_parser("smoke", help="phase 2 step 0: QLoRA feasibility run on the base (GPU)")
    sm.add_argument("--plan", action="store_true", help="print requirements only, download and train nothing")
    sub.add_parser("perplexity", help="phase 2 step 0: 4-bit vs 16-bit perplexity on persona text (GPU)")
    sv = sub.add_parser("serve", help="dedicated llama-server with adapters: start, stop, status, swap")
    sv.add_argument("action", choices=["start", "stop", "status", "swap", "config"])
    sv.add_argument("--serve-config", help="JSON file with ServeConfig fields")
    sv.add_argument("--adapter", help="GGUF adapter path for start (active) or swap (new)")
    sub.add_parser("gpu", help="show the GPU lock holder, idle time and VRAM use")
    args = p.parse_args(argv)

    tcfg = TrainConfig.load(args.config)
    cfg = Config()
    if args.cmd == "plan":
        print(tcfg.dump())
        print("base candidates:", ", ".join(BASE_CANDIDATES), file=sys.stderr)
        return 0
    if args.cmd == "dataset":
        from .dataset import build_dataset

        store = MemoryStore(cfg.db_path)
        ensure_seeded(store)
        system = build_system_prompt(load_persona(cfg.persona_path), read_profile(cfg.profile_path), [],
                                     beliefs=render(store.beliefs()))
        out = Path(args.out or tcfg.dataset_path)
        print(json.dumps(build_dataset(store, system, tcfg, out), indent=2))
        return 0
    if args.cmd == "train":
        from .train_qlora import train

        print(train(tcfg, dry_run=args.dry_run))
        return 0
    if args.cmd == "convert":
        from .convert import convert

        print(convert(tcfg, Path(args.adapter_dir) if args.adapter_dir else None))
        return 0
    if args.cmd == "swap":
        from .swap import persona_check, swap

        system = build_system_prompt(load_persona(cfg.persona_path), read_profile(cfg.profile_path), [])
        res = swap(tcfg.server_url, args.adapter, tcfg.adapter_scale, lambda: persona_check(cfg.api_base, cfg.model, system))
        print("ok" if res.ok else "failed", res.reason)
        for r in res.replies:
            print("  >", r)
        return 0 if res.ok else 1
    if args.cmd == "smoke":
        from .smoke import run

        print(json.dumps(run(tcfg, plan_only=args.plan), indent=2))
        return 0
    if args.cmd == "perplexity":
        from .perplexity import run

        print(json.dumps(run(tcfg), indent=2))
        return 0
    if args.cmd == "gpu":
        from ..gpu import status

        print(json.dumps(status(), indent=2))
        return 0
    if args.cmd == "serve":
        from .serve import Server, dump_serve_config, load_serve_config
        from .swap import persona_check

        scfg = load_serve_config(args.serve_config)
        srv = Server(scfg)
        if args.action == "config":
            print(dump_serve_config(scfg))
            return 0
        if args.action == "status":
            print(json.dumps({"healthy": srv.healthy(), **srv.state()}, indent=2))
            return 0
        if args.action == "start":
            adapters = [args.adapter] if args.adapter else list(srv.state().get("adapters", []))
            print("pid", srv.start(adapters, active=args.adapter))
            return 0
        if args.action == "stop":
            print("stopped" if srv.stop() else "not running")
            return 0
        if args.action == "swap":
            if not args.adapter:
                p.error("swap needs --adapter")
            system = build_system_prompt(load_persona(cfg.persona_path), read_profile(cfg.profile_path), [])
            res = srv.swap(args.adapter, lambda: persona_check(scfg.url + "/v1", scfg.alias, system))
            print("ok" if res.ok else "failed", res.reason)
            return 0 if res.ok else 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
