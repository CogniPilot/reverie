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

This tool performs acceptance, not speech inference. The surviving Python
`service.py` and `audio.py`, real Whisper/Kokoro engines, and shell orchestrator
remain separate migration work. A Rust verifier does not remove those dependencies.

The native integration control runs the real CLI against an owned deterministic
HTTP fixture. It checks successful acceptance and refusals for voice, timing,
browser duration, silence, short audio, missing endpoints, HTTP failure, invalid
JSON, empty recognition and an escaped ASR negative control. The test server
models transport responses; it does not qualify real speech recognition.

For migration parity, set `REVERIE_VOICE_CI_PARENT` to the unchanged parent
checkout when running the acceptance test. Each case also runs that checkout's
existing verifier, comparing exit success, receipt/report JSON, progress events,
transcripts and the exact ten-second PCM bytes. Only measured `recognitionMs`
values are excluded. Set `REVERIE_VOICE_CI_EVIDENCE` to a fresh existing directory
to retain each case's artifacts and raw verifier stdout, stderr and exit record.
Real-model acceptance remains the voice-CI workflow gate.
