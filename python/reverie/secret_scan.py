"""Credential detectors for text the reverie stores durably (model outputs now, ingested turns later).

``find`` returns detector names only, never the matched text, so a drop log or receipt can say
why something was refused without copying the secret. The patterns aim at real credential
shapes: a bare ``sk-`` would also match ``task-``, ``risk-`` and ``disk-``. Long hex strings and
UUIDs are deliberately not flagged (git SHAs and ids are everywhere in engineering text); the
entropy rule only looks at mixed-case base64-like tokens.
"""
from __future__ import annotations

import math
import re
from collections import Counter

PATTERNS = {
    # Real keys carry digits; "sk-learn-compatible-..." does not.
    "openai_or_anthropic_key": r"\bsk-(?:ant-|proj-)?(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{20,}",
    "stripe_key": r"\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}",
    "github_token": r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})",
    "slack_token": r"\bxox[abprs]-[A-Za-z0-9-]{10,}",
    "aws_access_key": r"\bAKIA[0-9A-Z]{16}\b",
    "google_api_key": r"\bAIza[0-9A-Za-z_-]{35}",
    "google_oauth_token": r"\bya29\.[0-9A-Za-z_-]{20,}",
    "huggingface_token": r"\bhf_[A-Za-z0-9]{30,}",
    "gitlab_token": r"\bglpat-[A-Za-z0-9_-]{20,}",
    "npm_token": r"\bnpm_[A-Za-z0-9]{36}",
    "pypi_token": r"\bpypi-[A-Za-z0-9_-]{50,}",
    "jwt": r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
    "private_key": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "url_credentials": r"://[^/\s:@]+:[^/\s@]+@",
    "authorization_header": r"(?i)\bauthorization\s*[:=]\s*[\"']?(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}",
    "bearer_token": r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}",
    "webhook_url": r"https://(?:hooks\.slack\.com/services|(?:discord|discordapp)\.com/api/webhooks)/\S+",
    "netrc_password": r"(?im)^\s*machine\s+\S+\s+login\s+\S+\s+password\s+\S+",
    # The key may follow "_" or "-" (client_secret, DB_PASSWORD, aws_secret_access_key), so no \b.
    # A value that is a call (tokenizer.encode(...)) or a placeholder ([REDACTED]) is not a secret.
    "assigned_secret": (r"(?i)(?<![A-Za-z0-9])(?:api[_-]?key|client[_-]?secret|secret(?:[_-]?(?:access[_-]?)?key)?|"
                        r"password|passwd|pwd|(?:access|refresh|auth|id)[_-]?token|token|account[_-]?key|access[_-]?key)"
                        r"[\"']?\s*[:=]\s*[\"']?(?!\[)(?![^\s\"',;]*\()[^\s\"',;\[\]]{8,}"),
}
_COMPILED = {name: re.compile(pattern) for name, pattern in PATTERNS.items()}
_TOKEN = re.compile(r"[A-Za-z0-9+_=-]{32,}")
_HEX_OR_UUID = re.compile(r"(?i)[0-9a-f-]+")


def _entropy(token: str) -> float:
    counts = Counter(token)
    return -sum(n / len(token) * math.log2(n / len(token)) for n in counts.values())


def high_entropy(text: str, threshold: float = 4.2) -> bool:
    """A 32+ character mixed-case alphanumeric token that is not hex/UUID-shaped and looks random."""
    for token in _TOKEN.findall(text):
        if _HEX_OR_UUID.fullmatch(token):
            continue
        if not (re.search(r"[a-z]", token) and re.search(r"[A-Z]", token) and re.search(r"[0-9]", token)):
            continue
        if _entropy(token) >= threshold:
            return True
    return False


def find(text: str) -> list[str]:
    """Names of the detectors that fire on ``text`` (empty when it looks clean)."""
    text = text or ""
    found = [name for name, pattern in _COMPILED.items() if pattern.search(text)]
    if high_entropy(text):
        found.append("high_entropy_token")
    return found


def leaks(text: str) -> bool:
    return bool(find(text))
