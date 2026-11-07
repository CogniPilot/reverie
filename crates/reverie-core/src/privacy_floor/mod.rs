//! The fixed private-person floor from floors.py. These are finite domain
//! grammars, not an arbitrary-regex interpreter or the owner's output policy.
//! All text facts come from the single frozen Python Unicode owner.
mod contact;
mod exempt;
use crate::{
    PythonText, PythonTextRef,
    python_text::{lower_codepoints, space_point, word_point},
};

/// Source splitlines/strip semantics: only column-zero '#' starts a comment.
pub fn protected_name_lines(text: PythonTextRef<'_>) -> Vec<PythonText> {
    let points = text.codepoints();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < points.len() {
        if crate::python_text::linebreak_point(points[index]) {
            push_name(&points[start..index], &mut lines);
            if points[index] == 13 && points.get(index + 1) == Some(&10) {
                index += 1;
            }
            start = index + 1;
        }
        index += 1;
    }
    if start < points.len() {
        push_name(&points[start..], &mut lines);
    }
    lines
}
fn push_name(points: &[u32], lines: &mut Vec<PythonText>) {
    if points.first() == Some(&35) {
        return;
    }
    let line = PythonTextRef::from_codepoints(points)
        .expect("input text checked")
        .trimmed();
    if !line.is_empty() {
        lines.push(line.into_owned());
    }
}
pub fn targets_private_person(text: PythonTextRef<'_>, names: &[PythonText]) -> bool {
    let text = text.codepoints();
    let names = names
        .iter()
        .map(|name| lower_codepoints(name.codepoints()))
        .collect::<Vec<_>>();
    let mut start = 0;
    for index in 1..text.len() {
        if matches!(text[index - 1], 33 | 46 | 63) && space_point(text[index]) {
            if sentence(&text[start..index], &names) {
                return true;
            }
            start = index;
            while start < text.len() && space_point(text[start]) {
                start += 1;
            }
        }
    }
    sentence(&text[start..], &names)
}
fn sentence(text: &[u32], names: &[Vec<u32>]) -> bool {
    let lowered = lower_codepoints(text);
    if names.iter().any(|name| substring(&lowered, name)) && abuse(text) {
        return true;
    }
    has_name(text) && contact::contains(text)
}
fn substring(text: &[u32], needle: &[u32]) -> bool {
    needle.is_empty() || text.windows(needle.len()).any(|part| part == needle)
}
fn boundary(text: &[u32], index: usize) -> bool {
    index
        .checked_sub(1)
        .is_some_and(|prior| word_point(text[prior]))
        != text.get(index).is_some_and(|&point| word_point(point))
}
fn case_ascii(point: u32, expected: u8) -> bool {
    if point == u32::from(expected) || point == u32::from(expected.to_ascii_uppercase()) {
        return true;
    }
    matches!(
        (point, expected),
        (0x130 | 0x131, b'i') | (0x17f, b's') | (0x212a, b'k')
    )
}
fn prefix(text: &[u32], start: usize, expected: &[u8]) -> Option<usize> {
    let end = start.checked_add(expected.len())?;
    text.get(start..end)?
        .iter()
        .zip(expected)
        .all(|(&point, &byte)| case_ascii(point, byte))
        .then_some(end)
}
fn abuse(text: &[u32]) -> bool {
    const PREFIXES: [&[u8]; 5] = [b"harass", b"stalk", b"dox", b"expose", b"threat"];
    const WORDS: [&[u8]; 4] = [b"address", b"phone", b"lives at", b"works at"];
    for index in 0..text.len() {
        if !boundary(text, index) {
            continue;
        }
        if WORDS
            .iter()
            .any(|word| prefix(text, index, word).is_some_and(|end| boundary(text, end)))
        {
            return true;
        }
        if PREFIXES.iter().any(|word| extended_word(text, index, word)) {
            return true;
        }
    }
    false
}
fn extended_word(text: &[u32], index: usize, word: &[u8]) -> bool {
    let Some(mut end) = prefix(text, index, word) else {
        return false;
    };
    while end < text.len() && word_point(text[end]) {
        end += 1;
    }
    boundary(text, end)
}
fn name_word(text: &[u32], start: usize) -> Option<usize> {
    if !text
        .get(start)
        .is_some_and(|&point| (65..=90).contains(&point))
    {
        return None;
    }
    let mut end = start + 1;
    while end < text.len() && (97..=122).contains(&text[end]) {
        end += 1;
    }
    (end > start + 1).then_some(end)
}
fn spaces(text: &[u32], start: usize) -> Option<usize> {
    let mut end = start;
    while end < text.len() && space_point(text[end]) {
        end += 1;
    }
    (end > start).then_some(end)
}
fn has_name(text: &[u32]) -> bool {
    (0..text.len()).any(|index| {
        boundary(text, index)
            && name_word(text, index)
                .and_then(|end| spaces(text, end))
                .and_then(|end| name_word(text, end))
                .is_some_and(|end| boundary(text, end))
    })
}
