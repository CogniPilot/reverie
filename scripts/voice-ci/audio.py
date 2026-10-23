"""Independent WAV/content acceptance for synthetic CI speech (no service mocks)."""
from __future__ import annotations

import array
import io
import math
import re
import sys
import wave


def inspect_wav(data: bytes) -> dict:
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("Expected a non-empty RIFF/WAVE response")
    if int.from_bytes(data[4:8], "little") + 8 != len(data):
        raise ValueError("RIFF length does not match captured bytes")
    with wave.open(io.BytesIO(data), "rb") as audio:
        channels, width, rate, frames = (audio.getnchannels(), audio.getsampwidth(),
                                         audio.getframerate(), audio.getnframes())
        if audio.getcomptype() != "NONE" or width != 2 or channels != 1 or not 8000 <= rate <= 96000:
            raise ValueError("Expected mono PCM16 speech at a supported sample rate")
        pcm = audio.readframes(frames)
    if frames <= 0 or len(pcm) != frames * width * channels:
        raise ValueError("WAV samples are empty or truncated")
    samples = array.array("h", pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    rms = math.sqrt(sum(int(n) ** 2 for n in samples) / len(samples)) / 32768
    if rms < 0.0001:
        raise ValueError("WAV contains no measurable speech signal")
    return {"sampleRate": rate, "frames": frames, "durationSeconds": frames / rate, "rms": rms}


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower().replace("’", "'"))


def check_transcript(expected: str, actual: str, max_wer: float, ending: str = "") -> dict:
    reference, hypothesis = words(expected), words(actual)
    if not reference or not hypothesis:
        raise ValueError("Expected and recognized speech must both be non-empty")
    previous = list(range(len(hypothesis) + 1))
    for i, target in enumerate(reference, 1):
        row = [i]
        for j, token in enumerate(hypothesis, 1):
            row.append(min(row[-1] + 1, previous[j] + 1,
                           previous[j - 1] + (target != token)))
        previous = row
    wer = previous[-1] / len(reference)
    if wer > max_wer:
        raise ValueError(f"Transcript WER {wer:.3f} exceeds {max_wer:.3f}")
    final = words(ending)
    if final and hypothesis[-len(final):] != final:
        raise ValueError("Transcript is missing the required reply ending")
    return {"wordErrorRate": wer, "expectedWords": len(reference), "recognizedWords": len(hypothesis)}


def check_duration(seconds: float, bounds: dict) -> None:
    if not math.isfinite(seconds) or not bounds["min"] <= seconds <= bounds["max"]:
        raise ValueError(f"Audio duration {seconds:.3f}s outside fixture bounds {bounds}")
