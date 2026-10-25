# Owner-selected runtime configuration

Repository defaults and examples are portable placeholders. Set actual identities,
models, paths and endpoints in the private instance overlay before running a service.
No runtime or test needs an installed personal instance.

All instances use the same generic agent model: `kind` defaults to `agent` and
`role` defaults to `Expert`. Set `role` to CTO, COO or another organizational title
without changing authority. The console owns role permissions; Python instance
configuration does not accept a `permissions` object. Employee recovery requires
an explicit console employee `permissions.recoverEmployees` grant.
Cycle policy selects its coordinator and separately controls `allow_implementation`
(default false), `allow_subagents`, `max_children`, `child_models` and `child_roles`.
Only owner-authorized policy grants orchestration or delegation authority.

Environment variables are named `REVERIE_*`.

The Admin Harness defaults to a 15-second general room scan. On an isolated laptop,
the website must explicitly opt in at startup with the per-instance environment variable
`REVERIE_ADMIN_PHONE_WAKE=enabled`. The default is OFF: attention returns unavailable,
no new private phone receipts are written, and automatic Admin Harness room effects
fail closed. Normal native delivery, joined-channel history and manual reads remain
available. The same new image can run OFF after activation: it preserves existing
receipts privately while ignoring them for actions and stripping them from public data.
After any receipt has been written, roll back only to a schema-aware image; an older
website may expose unfamiliar stored fields. Enabling the instance setting allows
one metadata-only long poll through its own office phone to wake the existing serial
loop for whatever its current canonical phone policy accepts. Ring, Vibrate and Silent
retain their existing owner/mention, room-notify, recipient and membership rules;
DMs do not bypass the phone setting. There is no separate mention filter.
It does not interrupt a running model turn or start a second one. The listener never
calls a model, reads message bodies or changes the normal durable message claims.
General scans cover reconnect gaps and use the same server acceptance; they cannot
reply to muted traffic. Messages discarded while muted cannot become new actions after
unmute. Ordinary joined-channel history, manual reads and memory access are unchanged;
muted and legacy messages may remain quoted historical context after a valid request.
`/status` shows whether phone wake is active,
connecting or unavailable; unavailable connections use polling with bounded retry.
Private `runtime-settings.json` accepts `phone_wake` (boolean) and `poll_s`
(1–300 seconds). The launcher defaults are `true` and `15`. Applying updated launch
code uses the owner's Restart session action, preserving saved identity and memory;
direct `tmux respawn-pane` bypasses lifecycle and office-relay setup. The matching
website API must provide verified phone acceptance; missing policy metadata prevents
automatic room replies rather than falling back to a local guess.

- `reverie.config`: `REVERIE_MODEL` defaults to `MODEL_ID`; select the served model alias.
  `REVERIE_API_BASE` defaults to the conventional loopback endpoint on port 8080.
  `REVERIE_INSTANCE_CONFIG` selects the identity and memory configuration explicitly.
- `reverie.persona`: `REVERIE_OWNER_ALIASES` and `REVERIE_AGENT_ALIASES` default to
  empty comma-separated lists. Neutral owner/assistant section prefixes always
  work; configure personal historical section aliases only in the instance overlay.
  Section names never grant identity or authorization.
- `reverie.beliefs` reads the optional `REVERIE_AGENT_ALIASES` list for historical
  self references. Its neutral default is empty; personal names stay in the overlay.
- `reverie.cycle_demo` requires `--model`. `reverie.opencode` accepts `--model` or
  `REVERIE_MODEL`, with neutral fallback `local_agent/MODEL_ID`; configure a real
  provider/model identifier before installing. Bridge actions need no model flag.
- Runtime policies select `backends.local.model` and `keep_alive.model_id`.
  `examples/runtime-policy.json` uses `MODEL_ID` placeholders; replace both.
- `reverie.sleep` takes `--policy`; all chat database, state, instance and employee
  selection values are supplied by that private policy. `examples/sleep.json` is
  dry-run only, with a generic instance path and a synthetic employee identifier.
- `reverie.supervise` takes `--state`, optional `--rollback-dist` and `--env-root`.
  `REVERIE_RUNTIME_POLICY` is the only child.env override allowed and must resolve
  to a regular file strictly within the supplied environment root.

`scripts/reverie-restore` requires `--rescue DIR` or `REVERIE_RESCUE_DIR`
(default empty), pointing at the owner-selected recovery snapshot.

## Training any expert

Training and adapter serving are shared tools for any expert, regardless of
organizational role. CTO and COO are roles of the same generic AI agent, and each
agent has its own memory. A title never grants orchestration or tool permission.
Select the expert's private instance with
`REVERIE_INSTANCE_CONFIG`. Give each expert a separate training JSON, dataset and
adapter output directory; set `dataset_path`, `output_root` and `run_name`
explicitly rather than sharing their defaults.

- [Training configuration](../python/reverie/train/config.py): set `base_model` in the
  training JSON; its neutral default is `MODEL_ID`. The public candidate list is
  informational; the owner selects the expert's model.
- [Adapter serving](../python/reverie/train/serve.py): `REVERIE_GGUF` defaults to
  `~/reverie/runtime/models/model.gguf`, `REVERIE_MODEL` to `MODEL_ID`, and
  `REVERIE_SERVE_PORT` to 8081. Set them for the selected expert's server and model
  file. Use a separate serving JSON with its own `state_path`, and distinct ports
  when running multiple servers.
  Snapshot metadata uses `snapshot-base.json`. `REVERIE_SNAPSHOT_MARKER` optionally
  names an older snapshot marker in the instance overlay; it defaults to empty.

## User service templates

`reverie-watcher.service` and `reverie-watcher-check.service` require
`%h/reverie/runtime/config/runtime.env` containing `REVERIE_RUNTIME_POLICY`, an absolute
container-visible policy path. No private policy path is compiled into the unit.

`reverie-stall-watch.service` requires `%h/reverie/runtime/config/stall-watch.env`
containing `REVERIE_STALL_WATCH_CONFIG`, the container-visible watchdog JSON path.
Its existing host-only token/reporting settings stay in that file. Dry-run remains
on by default; the config existence check runs inside the container.

`reverie-sleep.service` requires `%h/reverie/runtime/config/sleep.env` containing
`REVERIE_SLEEP_POLICY`. These templates must be reviewed and configured by the owner;
synchronizing the source never activates a service.
