#!/usr/bin/env bash
set -euo pipefail
umask 077
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
: "${REVERIE_VOICE_CI_ARTIFACTS:?Set a fresh task artifact directory}"
: "${CHROMIUM_PATH:?Run in nix develop .#voice-ci}"
: "${REVERIE_VOICE_CI_WHISPER_MODEL:?Missing pinned Whisper model}"
: "${REVERIE_VOICE_CI_KOKORO_MODEL:?Missing pinned Kokoro model}"
: "${REVERIE_VOICE_CI_KOKORO_VOICES:?Missing pinned Kokoro voices}"
mkdir "$REVERIE_VOICE_CI_ARTIFACTS"
REVERIE_VOICE_CI_ARTIFACTS=$(cd "$REVERIE_VOICE_CI_ARTIFACTS" && pwd)
export REVERIE_VOICE_CI_ARTIFACTS
private_home="$REVERIE_VOICE_CI_ARTIFACTS/home"
mkdir -p "$private_home/tmp"
speech_pid= console_pid=
cleanup() {
  for pid in "$console_pid" "$speech_pid"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  for ((attempt=0; attempt<10; attempt++)); do
    if ! { [ -n "$console_pid" ] && kill -0 "$console_pid" 2>/dev/null; } &&
       ! { [ -n "$speech_pid" ] && kill -0 "$speech_pid" 2>/dev/null; }; then break; fi
    sleep 0.2
  done
  for pid in "$console_pid" "$speech_pid"; do
    if [ -n "$pid" ]; then kill -KILL "$pid" 2>/dev/null || true; fi
  done
  for pid in "$console_pid" "$speech_pid"; do
    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT INT TERM
# Whitelist the fixture environment. A shell inherited from an expert must not
# turn this route fixture into a reader/writer of the live owner data directory.
fixture_env=(env -i "PATH=$PATH" "HOME=$private_home" "TMPDIR=$private_home/tmp"
  "PYTHONPATH=$repo_root/python" "REVERIE_DATA_DIR=$private_home/data" "REVERIE_RUNTIME_TEST=1"
  "REVERIE_VOICE_CI_ARTIFACTS=$REVERIE_VOICE_CI_ARTIFACTS" "CHROMIUM_PATH=$CHROMIUM_PATH"
  "PHONEMIZER_ESPEAK_LIBRARY=$PHONEMIZER_ESPEAK_LIBRARY"
  "REVERIE_VOICE_CI_WHISPER_MODEL=$REVERIE_VOICE_CI_WHISPER_MODEL"
  "REVERIE_VOICE_CI_KOKORO_MODEL=$REVERIE_VOICE_CI_KOKORO_MODEL"
  "REVERIE_VOICE_CI_KOKORO_VOICES=$REVERIE_VOICE_CI_KOKORO_VOICES"
  OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2)
"${fixture_env[@]}" python3 scripts/voice-ci/service.py --artifacts "$REVERIE_VOICE_CI_ARTIFACTS" \
  > "$REVERIE_VOICE_CI_ARTIFACTS/speech.log" 2>&1 &
speech_pid=$!
wait_ready() {
  local file=$1 pid=$2
  for ((attempt=0; attempt<180; attempt++)); do
    if [ -s "$file" ]; then return; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      cat "$REVERIE_VOICE_CI_ARTIFACTS/"*.log
      return 1
    fi
    if ((attempt % 5 == 0)); then printf 'voice-ci startup heartbeat %ss: %s\n' "$attempt" "$(basename "$file")"; fi
    sleep 1
  done
  printf 'Timed out waiting for %s\n' "$file" >&2
  return 1
}
wait_ready "$REVERIE_VOICE_CI_ARTIFACTS/speech-url.txt" "$speech_pid"
"${fixture_env[@]}" node --import ./apps/web/node_modules/tsx/dist/loader.mjs apps/web/scripts/voice-ci-server.ts \
  > "$REVERIE_VOICE_CI_ARTIFACTS/console.log" 2>&1 &
console_pid=$!
wait_ready "$REVERIE_VOICE_CI_ARTIFACTS/console-url.txt" "$console_pid"
"${fixture_env[@]}" node apps/web/scripts/voice-ci-browser.mjs
"${fixture_env[@]}" python3 scripts/voice-ci/verify.py --artifacts "$REVERIE_VOICE_CI_ARTIFACTS"
