"""Owner-configurable output checks and generic private-data protection."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from reverie import env_names


def output_policy_violation(text: str) -> bool:
    """Apply owner-selected regex rules; the platform supplies no topic vocabulary."""
    policy = json.loads(env_names.get("OUTPUT_POLICY", "{}"))
    if not isinstance(policy, dict) or set(policy) - {"denied_patterns"}:
        raise ValueError("output policy must contain only denied_patterns")
    patterns = policy.get("denied_patterns", [])
    if not isinstance(patterns, list) or any(not isinstance(p, str) or not p for p in patterns):
        raise ValueError("denied_patterns must be a list of nonempty regex strings")
    compiled = [re.compile(pattern, re.I) for pattern in patterns]
    return any(pattern.search(text or "") for pattern in compiled)


_ABUSE = re.compile(r"\b(?:harass\w*|stalk\w*|dox+\w*|expose\w*|threat\w*|address|phone|lives at|works at)\b", re.I)
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

PROTECTED_PEOPLE = Path(env_names.lookup("REVERIE_PROTECTED_PEOPLE", Path.home() / ".reverie" / "default" / "protected-people.txt"))


def protected_names(path: Path | None = None) -> list[str]:
    p = path or PROTECTED_PEOPLE
    try:
        return [l.strip() for l in p.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]
    except OSError:
        return []


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
    if output_policy_violation(text):
        return "configured output policy"
    if targets_private_person(text, names):
        return "targeting a real private person"
    return ""


def passes(text: str, names: list[str] | None = None) -> bool:
    return not violates(text, names)

