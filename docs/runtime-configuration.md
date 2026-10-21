# Owner-selected runtime configuration

Repository defaults and examples are portable placeholders. Set actual identities,
models, paths and endpoints in the private instance overlay before running a service.
No runtime or test needs an installed personal instance.

Environment variables are named `REVERIE_*`. The older `FLEET_*` spelling of each name is
still read for one release: when both are set the `REVERIE_*` value wins, and a component that
falls back prints one deprecation line naming the new variable. Launchers pass both spellings to
the containers and children they start, so an older console or runtime on the same host keeps
working during the upgrade. Rename the variables in owner env files (for example
`~/.config/reverie/runtime.env`) at your next edit; nothing breaks before then.

- `cto.config`: `REVERIE_MODEL` defaults to `MODEL_ID`; select the served model alias.
  `REVERIE_API_BASE` defaults to the conventional loopback endpoint on port 8080.
  `REVERIE_INSTANCE_CONFIG` selects the identity and memory configuration explicitly.
- `cto.persona`: `REVERIE_OWNER_ALIASES` and `REVERIE_AGENT_ALIASES` default to
  empty comma-separated lists. Neutral owner/assistant section prefixes always
  work; configure personal historical section aliases only in the instance overlay.
  Section names never grant identity or authorization.
- `cto.beliefs` reads the optional `REVERIE_AGENT_ALIASES` list for historical
  self references. Its neutral default is empty; personal names stay in the overlay.
- `cto.cycle_demo` requires `--model`. `cto.opencode` accepts `--model` or
  `REVERIE_MODEL`, with neutral fallback `local_agent/MODEL_ID`; configure a real
  provider/model identifier before installing. Bridge actions need no model flag.
- `cto.train.config`: set `base_model` in the training JSON; its neutral default
  is `MODEL_ID`. The public candidate list is informational, not an instance choice.
- `cto.train.serve`: `REVERIE_GGUF` defaults to
  `~/.local/share/reverie/models/model.gguf`, `REVERIE_MODEL` to `MODEL_ID`, and
  `REVERIE_SERVE_PORT` to 8081. Set them for the selected server and model file.
  Snapshot metadata uses `snapshot-base.json`. `REVERIE_SNAPSHOT_MARKER` optionally
  names an older snapshot marker in the instance overlay; it defaults to empty.
- Runtime policies select `backends.local.model` and `keep_alive.model_id`.
  `examples/runtime-policy.json` uses `MODEL_ID` placeholders; replace both.
- `cto.sleep` takes `--policy`; all chat database, state, instance and employee
  selection values are supplied by that private policy. `examples/sleep.json` is
  dry-run only, with a generic instance path and a synthetic employee identifier.
- `cto.supervise` takes `--state`, optional `--rollback-dist` and `--env-root`.
  `REVERIE_RUNTIME_POLICY` is the only child.env override allowed and must resolve
  to a regular file strictly within the supplied environment root.

`scripts/reverie-restore` requires `--rescue DIR` or `REVERIE_RESCUE_DIR`
(default empty), pointing at the owner-selected recovery snapshot.

## User service templates

`reverie-watcher.service` and `reverie-watcher-check.service` require
`%h/.config/reverie/runtime.env` containing `REVERIE_RUNTIME_POLICY`, an absolute
container-visible policy path. No private policy path is compiled into the unit.

`reverie-stall-watch.service` requires `%h/.config/reverie/stall-watch.env`
containing `REVERIE_STALL_WATCH_CONFIG`, the container-visible watchdog JSON path.
Its existing host-only token/reporting settings stay in that file. Dry-run remains
on by default; the config existence check runs inside the container.

`reverie-sleep.service` requires `%h/.config/reverie/sleep.env` containing
`REVERIE_SLEEP_POLICY`. These templates must be reviewed and configured by the owner;
synchronizing the source never activates a service.
