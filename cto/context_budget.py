"""A conservative adapter-independent budget for recalled short-term exchanges."""
from __future__ import annotations


def memory_byte_budget(context_window: int = 16384, output_tokens: int = 4096,
                       occupied_tokens: int = 0, fixed_text: str = "") -> int:
    for value in (context_window, output_tokens, occupied_tokens):
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise ValueError("model context limits must be nonnegative integers")
    if context_window < 1024 or context_window > 10000000:
        raise ValueError("unsupported context window")
    # UTF-8 bytes are a deliberately conservative estimate, not tokenizer counts.
    # Leave tool/safety headroom in addition to the adapter's occupied prompt.
    remaining = context_window - output_tokens - occupied_tokens - 2048 - len(fixed_text.encode())
    return max(0, min(32000, context_window // 5, remaining // 2))


def recent_exchanges(messages: list[dict], budget: int) -> str:
    kept = []
    used = 0
    # Keep complete user/assistant exchanges, newest first for selection, then
    # chronological for rendering. Never cut a quotation into a new instruction.
    for index in range(len(messages) - 2, -1, -2):
        pair = messages[index:index + 2]
        if len(pair) != 2:
            continue
        rendered = "\n".join(str(m["role"]) + ": " + str(m["content"]) for m in pair)
        cost = len(rendered.encode()) + 2
        if used + cost > budget:
            break
        kept.append(rendered)
        used += cost
    return "\n\n".join(reversed(kept))


def assignment_byte_budget(context_window: int, output_tokens: int = 4096,
                           occupied_tokens: int = 0) -> int:
    """Conservative budget for a task brief after identity/tools/output reservation."""
    # Reuse validation without applying the smaller autobiographical recall cap.
    memory_byte_budget(context_window, output_tokens, occupied_tokens)
    return max(0, min(32000, context_window - output_tokens - occupied_tokens - 2048))
