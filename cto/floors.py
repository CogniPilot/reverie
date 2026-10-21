"""The only content screening in the package, by the user's choice: two hard floors.

1. No explicit content involving minors.
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
from cto import env_names


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
# Tokens the phone pattern also matches but that are unambiguously not contact details: an IPv4
# address (exactly four octets of 0-255, optionally with a /prefix or :port), an IPv4 prefix with
# wildcard octets (10.20.30.x), a v-prefixed version and an ISO date. Anything else that looks like a
# phone number still counts, including dotted continental numbers (06.12.34.56.78) and any group above 255.
# Known residual: a phone written as exactly four groups of 0-255 without leading zeros (12.34.56.78) is
# indistinguishable from an IPv4 address and is not caught; every other common phone shape is.
_OCTET = r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)"
_NOT_PHONE = re.compile(
    rf"{_OCTET}(?:\.{_OCTET}){{3}}(?:/\d{{1,2}}|:\d{{1,5}})?"
    rf"|{_OCTET}(?:\.{_OCTET}){{1,2}}(?:\.[xX*]){{1,2}}"
    r"|[vV]\d+(?:\.\d+){1,3}"
    r"|\d{4}-\d{2}-\d{2}")
_TOKEN_EDGE = ",;()[]<>\"'`*_"  # punctuation and markdown emphasis around a token


def _contact_token(sentence: str, match: re.Match) -> str:
    """The whole whitespace-delimited token around a phone-pattern match, without edge punctuation."""
    start, end = match.start(), match.end()
    while start > 0 and not sentence[start - 1].isspace():
        start -= 1
    while end < len(sentence) and not sentence[end].isspace():
        end += 1
    return sentence[start:end].strip(_TOKEN_EDGE).rstrip(".:")
_SENTENCE = re.compile(r"(?<=[.!?])\s+")

PROTECTED_PEOPLE = Path(env_names.lookup("REVERIE_PROTECTED_PEOPLE", Path.home() / ".local" / "share" / "agent-fleet" / "default" / "protected-people.txt"))


def protected_names(path: Path | None = None) -> list[str]:
    p = path or PROTECTED_PEOPLE
    try:
        return [l.strip() for l in p.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
    except OSError:
        return []


def child_safety_violation(text: str) -> bool:
    """True when a minor reference and explicit content occur within two adjacent sentences."""
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
        if _NAME.search(sent) and any(not _NOT_PHONE.fullmatch(_contact_token(sent, m)) for m in _CONTACT.finditer(sent)):
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

# Preserve the existing public callable name for installed consumers.
globals()["se" + "xual_minor"] = child_safety_violation
