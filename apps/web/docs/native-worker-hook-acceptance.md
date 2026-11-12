# Native worker hook component acceptance

`scripts/test-native-worker-hooks.ts` exercises the real owner HTTP setup,
session creation, interactive start and same-Session restart. The website runs
with an empty, isolated home and state directory, an ephemeral HTTP port and
its own tmux server. It launches the immutable native worker client. An owned
Unix socket captures the actual J frame without manufacturing an accepted job
or provider-health response.

The Rust test entry decodes those original bytes with `WorkerRequest`, produces
the canonical private launch record and starts a disposable container from an
explicit immutable image ID. It verifies the actual guest child ELF against
the image's embedded ABI manifest and declared immutable Nix package. Only
fixture workspace, provider and Office directories are mounted. Network access
is disabled. A tracked deterministic provider stand-in replaces the first
autoenv executable directory, preventing commercial provider execution.

That stand-in reads the prepared settings at the actual requested cwd and
executes its generated hook command. The packaged guest relay forwards through
an actual Rust Office phone to the real HTTP routes. The test compares settings
bytes captured after preparation with the guest's observations. Only actual
guest stdout is relayed back to the original native client; readiness text and
control receipts are never synthesized.

The eight cases verify current consent, missing and invalid generations,
Office session binding, current wait completion, a new private epoch after an
owner restart, rejection of the exact predecessor request and successor
completion. Private generations must remain absent from HTTP session state.
The stand-in proves the generated command's transport; it does not qualify a
commercial provider's interpretation of its hook configuration.

From the repository root, build the checked native client and host test
executable in isolated outputs:

```sh
nix build .#workerNativeClient --out-link /tmp/native-hook-client
nix develop --command env CARGO_TARGET_DIR=/tmp/native-hook-target \
  cargo test --locked -p reverie-host --lib --no-run --message-format=json
```

Then, from `apps/web`, use the `executable` emitted for the `reverie_host`
test artifact:

```sh
node --import tsx scripts/test-native-worker-hooks.ts \
  --image sha256:IMMUTABLE_WORKER_IMAGE \
  --worker-exec /tmp/native-hook-client/bin/reverie-worker-exec \
  --host-tests /tmp/native-hook-target/debug/deps/reverie_host-ARTIFACT \
  --docker /absolute/path/to/docker --tmux /absolute/path/to/tmux \
  --output /absolute/path/to/synthetic-component-report.json
```

The image's declared child package must also be available in the local Nix
store for byte comparison. The Docker engine must be local. After successful
subprocess settlement, the command removes only exact CIDs recorded by its own
creates, with matching fixture labels, and verifies their absence. Subprocess
owners bound output, deadlines and their own process groups; they do not claim
custody of escaped descendants. A failed attempt retains private inputs and
reports their directory instead of racing unconfirmed processes with container
cleanup. Those inputs contain synthetic credentials and private launch
generations and must not be uploaded. The optional successful JSON report
contains synthetic observations and artifact hashes, not those private inputs.

This is component acceptance. It does not qualify ordinary native broker Gate
admission, image enrollment, native resource replacement or durable launch
reconciliation. Those release requirements remain independent.
