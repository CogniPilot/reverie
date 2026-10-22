"""Load an agent's durable identity and bounded task context from any backend."""
from __future__ import annotations
import argparse
import os
from pathlib import Path
from .chat import ChatDaemon
from .config import Config
from .opencode import dispatch
from reverie import env_names


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instance", type=Path, default=env_names.lookup("REVERIE_INSTANCE_CONFIG"))
    parser.add_argument("--channel", choices=("work","private"), default="work")
    parser.add_argument("--context-window", type=int, default=16384)
    parser.add_argument("--output-tokens", type=int, default=4096)
    parser.add_argument("--occupied-tokens", type=int, default=0)
    args=parser.parse_args(argv)
    if not args.instance: parser.error("select an explicit external instance")
    daemon=ChatDaemon(cfg=Config(instance_config=args.instance))
    try:
        print(dispatch(daemon.brain, {"action":"context", "channel":args.channel,
            "context_window":args.context_window, "output_tokens":args.output_tokens,
            "occupied_tokens":args.occupied_tokens}))
    finally: daemon.brain.store.close()
    return 0

if __name__ == "__main__": raise SystemExit(main())
