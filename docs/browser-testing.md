# Browser tests in the development container

The application image is built by `nix build .#dockerImage` from the same runtime
as the native package. Browser testing requires a separately prepared browser
runtime with its matching system libraries; Debian apt dependency lists do not
apply to this Nix image. `docker/playwright-system-packages.txt` records the earlier
Debian image setup as reference, and is not installed by the current image build.

For a Nix-pinned Chromium runtime, build `.#browserRuntime`; the optional
`.#workerBrowserImage` also bundles it for isolated laptops. See
[opt-in worker GPU/browser capability](worker-gpu.md) for explicit device grants,
the bounded hardware probe and pending container acceptance. WebKit still needs
its separately prepared runtime.

Inside the container, use a versioned, user-owned cache:

```sh
export PLAYWRIGHT_BROWSERS_PATH=/scratch/cache/playwright-1.60.0
export npm_config_cache=/scratch/cache/npm/playwright-tools-1.60.0
export TMPDIR=/scratch/tmp
npx --yes playwright@1.60.0 --version
npx --yes playwright@1.60.0 install chromium webkit
```

Use the same Playwright version in the screenshot helper's dependencies and browser
installation command. Pass `PLAYWRIGHT_BROWSERS_PATH` when running the helper;
it does not change browser discovery in other sessions. Store screenshots and
traces under `/scratch/build/<task>` or `/scratch/profiles/<task>`. Keep files local
unless the owner explicitly authorizes an upload.

Verify both engines against an isolated local HTML page before using the browser
runtime for acceptance testing. WebKit emulation is a smoke check, not proof of
behavior on a physical iPhone.

When updating Playwright, prepare matching browser libraries and verify both engines again. The dependency install measured on the
2026-10-16 slim runtime added 354 packages (about 757 MB installed, 219 MB download),
with no upgrades or removals. Package versions remain supplied by Debian's
configured repositories; the package list is tied to Playwright 1.60.0, not a
frozen Debian snapshot.

## Voice audio acceptance

The root `Voice audio acceptance` workflow runs sandboxed Chromium against a
loopback fixture containing the production voice routes and car playback code.
Its agent replies are fixed synthetic text; its Kokoro synthesis and Whisper
recognition are real. The CI-only adapter uses Kokoro for both route protocols;
it does not qualify an operator's Piper service or deploy any speech service.
Dependencies come from `flake.lock`. `nix/voice-ci.nix` pins each speech model by
SHA256, including the upstream [Whisper tiny.en checkpoint](https://github.com/openai/whisper/blob/main/whisper/__init__.py).
Kokoro uses the same model hashes and package as `reverie-kokoro`. Whisper is MIT
licensed; Kokoro packaging retains its Apache-2.0 license metadata. These test
models are separate from the production image.

From a clean checkout, install the locked JavaScript dependencies without browser
downloads, then run the guarded harness with a **new** artifact directory:

```bash
nix develop .#voice-ci --command npm ci --prefix apps/web --ignore-scripts
export REVERIE_VOICE_CI_ARTIFACTS=/scratch/build/voice-ci-run-001
nix develop .#voice-ci --command python3 -m reverie.buildenv \
  --project voice-ci --repo "$PWD" --expect 4G --disk 2G --jobs 1 \
  -- bash scripts/test-voice-ci.sh
```

The script clears inherited instance settings, uses a private fixture home and
ephemeral loopback ports, and tears down only its own service processes. Those
services remain in the resource guard's process group.
The guard defaults to `/scratch` on laptops. Hosted CI explicitly uses
`--scratch "$RUNNER_TEMP/voice-ci-build"`; it creates that task root and its temp
directory before checking disk space. Memory/PID admission, disk reserve,
process-group watchdog and measurement ledger remain enabled. Cache, build and
default ledger paths all stay under the selected root.

Validator/launcher checks and real audio acceptance are separate workflow steps.
A zero-failure validator summary does not mean the browser or speech engines ran.
Only a completed browser run followed by every real Whisper comparison and the
ten-second negative control writes `acceptance.json`; partial reports are retained
for diagnosis and cannot satisfy that final success check.
It requires an explicit `CHROMIUM_PATH`, keeps Chromium's sandbox enabled and
fails if the browser, model or service is unavailable. Ubuntu CI enables
unprivileged user namespaces on its disposable runner to support that sandbox.
No owner endpoints, accounts, recordings, external LLM or GPU are required.

Both `/api/voice/speak` and `/api/voice/turn` return JSON with an audio URL. The
harness follows those URLs and keeps every successful utterance's WAV. It checks
RIFF lengths, PCM frame counts, non-silent samples, decoded duration and actual
Whisper transcripts. Transcript comparison normalizes case and punctuation,
allows a fixture-specific word error rate, and requires the long reply's final
words. An independently shortened, valid ten-second WAV must fail both duration
and real recognition checks. Timing artifacts distinguish request start, headers,
body completion, playback and service synthesis spans; a five-second heartbeat
shows that a quiet stage is still being observed.

`scripts/voice-ci/fixtures.json` defines the synthetic reply, duration bounds and
latency budgets. Its initial 18–40 second duration interval and generous latency
ceilings require qualification on the pinned CI environment before calling this
an accepted performance baseline. Bounds must be reviewed against measured audio,
never automatically rewritten to fit a failing run. The long-clip playback test
injects transient `waiting`/`playing` events while real audio continues: a stale
ten-second watchdog must not interrupt resumed playback.

For selected member voices, `/voice/speak` must request and report `am_michael`
on every utterance. `/voice/turn` currently leaves voice choice to its upstream
service; this adapter records its configured effective `am_michael` default
separately, so it does not pretend that the turn route forwards a member voice.
The harness injects a later voice-ID mismatch and a later unavailable clip and
requires whole-reply replay with a visible fallback notice.

Phone `speechSynthesis` audio cannot be captured here. That branch is checked
with synthetic native-voice objects at the **selection, batch consistency and
indicator** level only; there is no claim of audible accent or speaker identity.
Likewise, Whisper establishes spoken content, not acoustic speaker identity.
The artifacts contain synthetic WAVs, transcripts, per-utterance voice metadata,
timings and a Playwright trace; model files and fixture-home state are excluded.
Real phone autoplay, interruption and hardware behavior remain device checks.

The car client shares one synthesis request lane per chat application, including
replacement car screens. It permits at most 32 waiting requests and retains the
existing 25-second queue-plus-request deadline; the production route still has
its 20-second limit. A cancelled or expired queued operation never starts. An
active operation drains before the lane is reused; cancellation is not a claim
that remote inference stopped. There is no automatic retry on busy or deadline
failure. Reply playback remains ordered, with complete-reply fallback and its
visible notice.

The CI speech adapter calls the production Engine directly for TTS, preserving
its nonblocking busy refusal instead of adding a hidden serialization lock.
Only ASR is serialized separately. Browser diagnostics record per-utterance
queue and request times; `synth-events.jsonl` records engine lock-attempt,
acquisition, inference start/end and completion times. All timestamps are
monotonic within their own process, never subtracted across clock origins.
Healthy-batch acceptance requires non-overlapping requests and complete timing;
actual WAV, ASR, duration, voice and latency bounds remain unchanged. Portable
busy/cancel/deadline controls do not establish real model performance.
