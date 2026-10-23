"""Validate every captured route clip using the running real Whisper adapter."""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
import time
import urllib.request
import wave

from audio import check_duration, check_transcript, inspect_wav


def recognize(base, wav):
    request = urllib.request.Request(base + "/stt", data=wav, headers={"Content-Type": "audio/wav"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)["transcript"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, required=True)
    args = parser.parse_args()
    root = args.artifacts
    fixture = json.loads(Path(__file__).with_name("fixtures.json").read_text())
    base = (root / "speech-url.txt").read_text().strip()
    clips = json.loads((root / "clips.json").read_text())
    if not clips or {c["endpoint"] for c in clips} != {"speak", "turn"}:
        raise ValueError("Both production routes must have captured audio")
    results = []
    try:
        for clip in clips:
            print(json.dumps({"phase": "recognition-start", "file": clip["file"]}), flush=True)
            wav = (root / clip["file"]).read_bytes()
            info = inspect_wav(wav)
            started = time.monotonic()
            transcript = recognize(base, wav)
            recognition_ms = (time.monotonic() - started) * 1000
            (root / (clip["file"] + ".transcript.txt")).write_text(transcript)
            long = clip["expected"] == fixture["reply"]
            content = check_transcript(clip["expected"], transcript, fixture["maxWordErrorRate"],
                                       fixture["requiredEnding"] if long else "")
            if long:
                check_duration(info["durationSeconds"], fixture["durationSeconds"])
            if clip["endpoint"] == "speak" and clip["voice"] != {"provider": "kokoro", "id": fixture["voice"]}:
                raise ValueError("Route changed the selected per-utterance voice")
            results.append({**clip, **info, **content, "transcript": transcript, "recognitionMs": recognition_ms})
            print(json.dumps({"phase": "recognition-complete", "file": clip["file"],
                              "recognitionMs": recognition_ms, **info, **content}), flush=True)
        for name in ("speak", "turn"):
            info = inspect_wav((root / f"{name}.wav").read_bytes())
            decoded = json.loads((root / f"{name}.browser.json").read_text())
            if abs(info["durationSeconds"] - decoded["duration"]) > 0.05:
                raise ValueError("Browser and PCM frame durations disagree")
        turn = json.loads((root / "turn.json").read_text())
        check_transcript(fixture["input"], turn["transcript"], fixture["maxWordErrorRate"])
        events = [json.loads(line) for line in (root / "synth-events.jsonl").read_text().splitlines()]
        if not events or any(e["effectiveVoice"] != fixture["voice"] or e["provider"] != "kokoro" for e in events):
            raise ValueError("Synth requests changed effective voice/provider")
        if any(e["responseNs"] <= e["requestNs"] for e in events):
            raise ValueError("Missing synth request/response timing")
        # A self-consistent, valid WAV that ends at 10 seconds must fail duration
        # AND actual ASR content acceptance, rather than just a corrupt header test.
        with wave.open(str(root / "speak.wav"), "rb") as source:
            output = io.BytesIO()
            with wave.open(output, "wb") as clipped:
                clipped.setparams(source.getparams())
                clipped.writeframes(source.readframes(source.getframerate() * 10))
        truncated = output.getvalue()
        (root / "negative-ten-seconds.wav").write_bytes(truncated)
        clipped_info = inspect_wav(truncated)
        try:
            check_duration(clipped_info["durationSeconds"], fixture["durationSeconds"])
        except ValueError:
            pass
        else:
            raise AssertionError("Ten-second negative control escaped duration gate")
        transcript = recognize(base, truncated)
        (root / "negative-ten-seconds.transcript.txt").write_text(transcript)
        try:
            check_transcript(fixture["reply"], transcript, fixture["maxWordErrorRate"], fixture["requiredEnding"])
        except ValueError:
            pass
        else:
            raise AssertionError("Ten-second negative control escaped real ASR gate")
    finally:
        (root / "audio-report.json").write_text(json.dumps(results, indent=2))
    # A partial audio report is useful on failure, but is never a pass receipt.
    # Emit this only after every clip and the real-ASR negative control pass.
    accepted = {"status": "passed", "recognizedClips": len(results),
                "endpoints": sorted({clip["endpoint"] for clip in results}),
                "tenSecondDurationAndAsrControl": "passed"}
    (root / "acceptance.json").write_text(json.dumps(accepted, indent=2))
    print(json.dumps({"phase": "real-audio-acceptance-complete", **accepted}), flush=True)


if __name__ == "__main__":
    main()
