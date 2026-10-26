# Coding with the Reverie Admin Harness

The `handsTools` flake package provides `reverie-hands-tools`. Its seven tools
read, list, search, edit and write workspace files, run commands and run a task's
configured tests. The dispatcher comes from the pre-integration Hands tools r1
implementation (SHA256 aec37a11815390dc7372d9e371838429ad1516dfe8cd37b9b05de3794c3d08cb).

The existing laptop container is the execution boundary. Commands have that
laptop's ordinary filesystem grants and network access. File-tool path checks
prevent accidental workspace escapes; they are not a second security sandbox.
Commands receive a clean environment without office or model tokens. Each tool
call has a time and output budget; commands remain in the controller's process
group so cancellation kills their descendants. The laptop's existing host
resource pool and task limit remain in force.

Configure `coding` in the employee's private Hands `runtime-settings.json`:
an absolute `root`, a `tool_schema_file` matching the version-one Hands export,
fixed `runner_argv`, named `profiles` and a `tasks` map. The runner argv includes
`--root ROOT`; the controller supplies the exact task directory and budgets.
Each task is a direct child of ROOT and has `manifest.json` with `version: 1`,
its `task_id`, and a `test_argv` array. Editable files live in its `work` directory.

Only the authenticated owner or explicitly configured delegate sessions may
start a task, and only from that task's configured rooms. Start with
`/code TASK_ID instructions @EMPLOYEE`; cancel with `/code-cancel TASK_ID`.
An external operator may retain the `[external agent] ` chat prefix; the same
delegate checks still apply. Chat takes priority over coding. A restart marks
interrupted jobs stopped rather than replaying them.

The server supplies owner authorization on scoped message reads from the
authenticated author's current account; a name, title or owner mark alone is
insufficient. Before continuing a coding task, the harness reads that exact
source message again and checks its author, text, current authorization and
phone policy. Missing or changed evidence stops the task. Ordinary conversation
replies do not establish that the coding backend has run: verify its file,
command and test receipts separately.

The default 60,000-character chat budget is too small for the coding controller's
tool reserves. Set private `prompt_cap_chars` to 120000 for coding. This is an
outer character ceiling, not a promise of a larger model context: configure the
native token meter in both chat and coding, with the actual model context limit,
so every model request reserves output tokens and fails closed if it will not fit.
# Image attachments on isolated laptops

The Reverie Admin Harness keeps vision enabled when the laptop masks the server's
attachment directory. It uses `reverie agent chat fetch` with the exact room and
file IDs, the configured image byte limit, and a short deadline. Downloads go to
a fresh private directory under `/scratch/tmp`, are checked for image type and
magic bytes, and are removed after conversion to model input. A membership or
download refusal never falls back to reading the server's filesystem path.

Native configurations outside a laptop retain their explicitly configured
`attachments_root/<room-id>` filesystem reader. Image-count and byte limits apply
to both modes. The scoped download changes no model, vision preference, phone
setting, coding permission, or tool authority.
