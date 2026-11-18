use reverie_core::{PythonText, python_regex};

const SPACE: &[u32] = &[b' ' as u32];
const THINK_START: &[u8] = b"<think>";
const THINK_END: &[u8] = b"</think>";

fn find(points: &[u32], token: &[u8]) -> Option<usize> {
    points.windows(token.len()).position(|part| {
        part.iter()
            .copied()
            .eq(token.iter().copied().map(u32::from))
    })
}

fn words(points: &[u32]) -> impl Iterator<Item = &[u32]> {
    points
        .split(|&point| python_regex::space(point))
        .filter(|word| !word.is_empty())
}

fn without_thoughts(mut remaining: &[u32]) -> Vec<u32> {
    let mut cleaned = Vec::new();
    while let Some(start) = find(remaining, THINK_START) {
        let after_start = &remaining[start + THINK_START.len()..];
        let Some(end) = find(after_start, THINK_END) else {
            break;
        };
        cleaned.extend_from_slice(&remaining[..start]);
        remaining = &after_start[end + THINK_END.len()..];
    }
    cleaned.extend_from_slice(remaining);
    cleaned
}

pub(super) fn clean(text: &PythonText, limit: i64) -> Vec<u32> {
    let without_thoughts = without_thoughts(text.codepoints());
    let plain: Vec<_> = without_thoughts
        .into_iter()
        .filter(|&point| point != u32::from(b'*'))
        .collect();
    let words: Vec<_> = words(&plain).collect();
    let mut cleaned = words.join(SPACE);
    let magnitude = usize::try_from(limit.unsigned_abs()).unwrap_or(usize::MAX);
    let cap = if limit.is_negative() {
        cleaned.len().saturating_sub(magnitude)
    } else {
        magnitude
    };
    cleaned.truncate(cap);
    cleaned
}

fn ends_sentence(word: &[u32]) -> bool {
    word.iter()
        .copied()
        .rev()
        .find(|&point| !b"\"')".iter().any(|&byte| point == u32::from(byte)))
        .is_some_and(|point| b".!?".iter().any(|&byte| point == u32::from(byte)))
}

pub(super) fn limit_words(text: &PythonText, limit: i64) -> Vec<u32> {
    let Some(limit) = usize::try_from(limit).ok().filter(|&limit| limit > 0) else {
        return text.codepoints().to_vec();
    };
    let words: Vec<_> = words(text.codepoints()).collect();
    if words.len() <= limit {
        return text.codepoints().to_vec();
    }
    let head = &words[..limit];
    let end = head
        .iter()
        .rposition(|word| ends_sentence(word))
        .map_or(limit, |index| index + 1);
    head[..end].join(SPACE)
}
