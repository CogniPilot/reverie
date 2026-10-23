"""Independent acceptance controls; these do not claim a real synthesis run."""
import importlib.util
import io
import math
from pathlib import Path
import struct
import unittest
import wave

module = importlib.util.spec_from_file_location("voice_ci_audio", Path(__file__).parents[1] / "scripts/voice-ci/audio.py")
audio = importlib.util.module_from_spec(module)
module.loader.exec_module(audio)


def wav(seconds=1, silent=False):
    result = io.BytesIO()
    with wave.open(result, "wb") as clip:
        clip.setnchannels(1)
        clip.setsampwidth(2)
        clip.setframerate(8000)
        clip.writeframes(b"".join(struct.pack("<h", 0 if silent else int(2000 * math.sin(i / 10)))
                                   for i in range(int(8000 * seconds))))
    return result.getvalue()


class VoiceAudioAcceptanceTests(unittest.TestCase):
    def test_real_sample_count_controls_duration(self):
        info = audio.inspect_wav(wav(20))
        self.assertEqual(info["durationSeconds"], 20)
        audio.check_duration(info["durationSeconds"], {"min": 18, "max": 40})
        with self.assertRaises(ValueError):
            audio.check_duration(audio.inspect_wav(wav(10))["durationSeconds"], {"min": 18, "max": 40})

    def test_empty_invalid_silent_and_truncated_responses_fail(self):
        for data in (b"", b"RIFFfake", wav(0), wav(silent=True), wav()[:-100]):
            with self.subTest(bytes=len(data)), self.assertRaises(ValueError):
                audio.inspect_wav(data)

    def test_transcript_normalization_and_edit_tolerance(self):
        result = audio.check_transcript("Before we leave, turn off the lights.",
                                        "Before we leave turn off the lights!", 0.18)
        self.assertEqual(result["wordErrorRate"], 0)
        with self.assertRaises(ValueError):
            audio.check_transcript("Before we leave, turn off the lights.", "Different content", 0.18)

    def test_tail_is_required_even_when_wer_is_small(self):
        prefix = "The complete recording has many words so losing one word is otherwise acceptable "
        with self.assertRaisesRegex(ValueError, "ending"):
            audio.check_transcript(prefix + "silver meadow lantern", prefix + "silver meadow", 0.18, "silver meadow lantern")

    def test_nan_duration_and_empty_asr_fail_closed(self):
        with self.assertRaises(ValueError):
            audio.check_duration(float('nan'), {"min": 18, "max": 40})
        with self.assertRaises(ValueError):
            audio.check_transcript("Expected words", "", 0.18)
