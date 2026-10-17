"""The only content screening in the package, by the user's choice: two hard floors.

1. A child-safety floor (vocabularies below are encoded).
2. No targeting of real private people.

Everything else about tone is governed by the user-owned persona file. These checks are
heuristics applied to generated text (replies, dreams, reflection insights, training
rows): a violation means the text is regenerated once or dropped. They are a floor, not
a guarantee; the persona's own rules remain the first line.

Floor 2 works from a list of protected names in ``~/.local/share/cto/protected-people.txt``
(one per line, maintained by the user) and flags text that pairs one of them with abuse
or exposure, plus any text that pairs a personal-looking name with contact details such
as a phone number, street address or email.
"""
from __future__ import annotations

import base64
import os
import re
from pathlib import Path


def _lexicon(encoded: str) -> str:
    """Screening vocabularies are stored base64-encoded so the source reads cleanly."""
    return base64.b64decode(encoded).decode("utf-8")


_MINOR = re.compile(_lexicon(
    "XGIoPzpjaGlsZCg/OnJlbik/fGtpZHM/fG1pbm9ycz98dW5kZXJhZ2V8dW5kZXItYWdlfHRlZW4oPzphZ2VyfHMpP3xwcmV0ZWVucz98dG9kZGxlcnM/fHNjaG9vbGdpcmxzP3xzY2hvb2xib3lzP3xsb2xpcz98c2hvdGFzP3xsaXR0bGUgKD86Z2lybHM/fGJveXM/KXwoPzoxWzAtN118WzEtOV0pWy0gXT8oPzp5ZWFycz98eXJzPylbLSBdb2xkKVxi"
), re.I)
_EXPLICIT = re.compile(_lexicon(
    "XGIoPzpzZXgoPzp1YWx8eXx1YWxseSk/fG51ZGV8bmFrZWR8ZXJvdGljfGFyb3VzZWQ/fGhvcm55fG9yZ2FzbVx3KnxmdWNrXHcqfGNvY2t8cHVzc3l8YnJlYXN0cz98Z2VuaXRhbFx3Knxtb2xlc3Rcdyp8Z3JvcFx3KnxzZWR1Y1x3Knx1bmRyZXNzXHcqfHN0cmlwXHcqfGxld2R8cG9yblx3KnxraXNzKD86ZWR8aW5nKT8gKD86aGltfGhlcnx0aGVtKSBkZWVwbHl8aW4gYmVkIHdpdGgpXGI="
), re.I)
_ABUSE = re.compile(_lexicon(
    "XGIoPzpoYXJhc3Ncdyp8c3RhbGtcdyp8ZG94K1x3KnxleHBvc2Vcdyp8aHVtaWxpYXRcdyp8dGhyZWF0XHcqfGh1cnR8a2lsbHxiZWF0XHcqfGF0dGFja1x3KnxydWluXHcqfHVnbHl8c3R1cGlkfHdvcnRobGVzc3xwYXRoZXRpY3xzbHV0XHcqfHdob3JlXHcqfGxvc2VyfGFkZHJlc3N8cGhvbmV8aG9tZXxsaXZlcyBhdHx3b3JrcyBhdClcYg=="
), re.I)
_CONTACT = re.compile(
    r"(?:\+?\d[\d\s().-]{7,}\d)|(?:\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct)\b)|"
    r"(?:[\w.+-]+@[\w-]+\.[\w.-]+)"
)
_NAME = re.compile(r"\b[A-Z][a-z]+\s+[A-Z][a-z]+\b")
_SENTENCE = re.compile(r"(?<=[.!?])\s+")

PROTECTED_PEOPLE = Path(os.environ.get("FLEET_PROTECTED_PEOPLE", Path.home() / ".local" / "share" / "agent-fleet" / "default" / "protected-people.txt"))


def protected_names(path: Path | None = None) -> list[str]:
    p = path or PROTECTED_PEOPLE
    try:
        return [l.strip() for l in p.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
    except OSError:
        return []


def child_safety_violation(text: str) -> bool:
    """True when both child-safety vocabularies match within two adjacent sentences."""
    sents = _SENTENCE.split(text or "")
    for i, sent in enumerate(sents):
        window = sent if i == 0 else sents[i - 1] + " " + sent
        if _MINOR.search(window) and _EXPLICIT.search(window):
            return True
    return False


def targets_private_person(text: str, names: list[str] | None = None) -> bool:
    """True when a protected name is paired with abuse or exposure, or a name is paired with contact details."""
    text = text or ""
    names = protected_names() if names is None else names
    for sent in _SENTENCE.split(text):
        low = sent.lower()
        if any(n.lower() in low for n in names) and _ABUSE.search(sent):
            return True
        if _CONTACT.search(sent) and _NAME.search(sent):
            return True
    return False


def violates(text: str, names: list[str] | None = None) -> str:
    """The name of the floor crossed, or an empty string when the text passes."""
    if child_safety_violation(text):
        return "child safety"
    if targets_private_person(text, names):
        return "targeting a real private person"
    return ""


def passes(text: str, names: list[str] | None = None) -> bool:
    return not violates(text, names)
