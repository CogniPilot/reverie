use super::{boundary, name_word, spaces};
use crate::python_text::{decimal_point, space_point, word_point};
pub(super) fn contains(text: &[u32]) -> bool {
    if email(text) || address(text) {
        return true;
    }
    let mut start = 0;
    while start < text.len() {
        if let Some(end) = phone(text, start) {
            if !super::exempt::not_phone(token(text, start, end)) {
                return true;
            }
            start = end;
        } else {
            start += 1;
        }
    }
    false
}
fn phone(text: &[u32], start: usize) -> Option<usize> {
    let first = if text[start] == 43 { start + 1 } else { start };
    if !text.get(first).is_some_and(|&point| decimal_point(point)) {
        return None;
    }
    let mut end = first + 1;
    while end < text.len()
        && (decimal_point(text[end])
            || space_point(text[end])
            || matches!(text[end], 40 | 41 | 46 | 45))
    {
        end += 1;
    }
    let last = (first + 1..end)
        .rev()
        .find(|&index| decimal_point(text[index]))?;
    (last >= first + 8).then_some(last + 1)
}
fn edge(point: u32) -> bool {
    b",;()[]<>\"'`*_"
        .iter()
        .any(|&byte| u32::from(byte) == point)
}
fn token(text: &[u32], mut start: usize, mut end: usize) -> &[u32] {
    while start > 0 && !space_point(text[start - 1]) {
        start -= 1;
    }
    while end < text.len() && !space_point(text[end]) {
        end += 1;
    }
    while start < end && edge(text[start]) {
        start += 1;
    }
    while end > start && edge(text[end - 1]) {
        end -= 1;
    }
    while end > start && matches!(text[end - 1], 46 | 58) {
        end -= 1;
    }
    &text[start..end]
}
fn email(text: &[u32]) -> bool {
    for at in 1..text.len() {
        if text[at] != 64 || !(word_point(text[at - 1]) || matches!(text[at - 1], 46 | 43 | 45)) {
            continue;
        }
        let mut end = at + 1;
        while end < text.len() && (word_point(text[end]) || text[end] == 45) {
            end += 1;
        }
        if end > at + 1
            && text.get(end) == Some(&46)
            && text
                .get(end + 1)
                .is_some_and(|&point| word_point(point) || matches!(point, 46 | 45))
        {
            return true;
        }
    }
    false
}
fn address(text: &[u32]) -> bool {
    const SUFFIXES: [&str; 15] = [
        "Street",
        "St",
        "Avenue",
        "Ave",
        "Road",
        "Rd",
        "Lane",
        "Ln",
        "Drive",
        "Dr",
        "Boulevard",
        "Blvd",
        "Way",
        "Court",
        "Ct",
    ];
    for start in 0..text.len() {
        if !boundary(text, start) || !decimal_point(text[start]) {
            continue;
        }
        let mut end = start;
        while end < text.len() && decimal_point(text[end]) {
            end += 1;
        }
        if end - start > 5 {
            continue;
        }
        let Some(mut end) = spaces(text, end).and_then(|end| name_word(text, end)) else {
            continue;
        };
        while let Some(next) = spaces(text, end) {
            if SUFFIXES.iter().any(|suffix| {
                let finish = next + suffix.len();
                text.get(next..finish)
                    .is_some_and(|part| part.iter().copied().eq(suffix.bytes().map(u32::from)))
                    && boundary(text, finish)
            }) {
                return true;
            }
            let Some(next_end) = name_word(text, next) else {
                break;
            };
            end = next_end;
        }
    }
    false
}
