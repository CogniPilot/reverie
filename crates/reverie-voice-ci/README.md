# Voice-CI acceptance

`reverie-voice-ci-verify --artifacts DIRECTORY` validates the existing browser and
route artifacts using the companion running speech adapter. The fixed fixture is
compiled from `scripts/voice-ci/fixtures.json`, which remains its single owner.

The verifier checks PCM frame duration and signal, transcript edit distance and
required ending, per-utterance voice, browser duration, actual inference timing,
and the valid ten-second WAV negative control through recognition. A partial
`audio-report.json` is retained on failure; `acceptance.json` is emitted only after
all checks pass. The existing receipt keys and progress-event phases are retained.

Hyper owns HTTP framing and the connection future stays owned on the current
runtime. The companion adapter address must be a loopback HTTP IP address; the
request has an absolute 90-second bound and recognition JSON is limited to 16 MiB.
These bounds narrow the old generic urllib transport. The fixture adapter already
uses a loopback address, no redirects, and small JSON responses. Timing counters
are nonnegative `u64` nanoseconds; the former Python control accepted unbounded
integers. JSON formatting is semantic, not byte-identical to Python serialization.

`reverie-voice-ci-serve` supplies real speech inference for the browser and
verifier. It uses the production Rust Kokoro engine and checks the ONNX graph
and voice archive before publishing readiness. Recognition uses a separately
serialized CPU-only Whisper.cpp process. The service verifies its Tiny.en
checkpoint and normalizes bounded WAV inputs to 16 kHz with FFmpeg. The
`voice-ci` flake shell supplies the pinned engines and model files.

The package depends on native speech libraries and executables. The separate
Console PTY build uses the default development shell for node-gyp.

The native integration control runs the real CLI against an owned deterministic
HTTP fixture. It checks successful acceptance and refusals for voice, timing,
browser duration, silence, short audio, missing endpoints, HTTP failure, invalid
JSON, empty recognition and an escaped ASR negative control. The test server
models transport responses; it does not qualify real speech recognition.

Every case checks a recorded contract digest for exit success, receipt and report
JSON, progress events, transcripts, and the exact ten-second PCM bytes. The
digests were captured from the original verifier at `dc07eb49e^` and validated
against the Rust CLI for all 11 cases. They sort JSON object keys and omit
measured `recognitionMs` values. Set `REVERIE_VOICE_CI_EVIDENCE` to a fresh existing
directory to retain each case's artifacts and raw verifier stdout, stderr and exit
record. Real-model acceptance remains the voice-CI workflow gate.
