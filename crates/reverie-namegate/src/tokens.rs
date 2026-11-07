//! Token sets and marker matches over cleaned text.

use crate::classes::{ignorecase_eq, is_decimal, is_letter_run};
use crate::lists::MarkerPart;
use std::collections::BTreeMap;

/// Lowercased tokens (ASCII camelCase pieces plus whole Unicode letter runs), each with the
/// character offset of its first occurrence.
pub(crate) fn tokens(text: &str) -> BTreeMap<String, usize> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = BTreeMap::new();
    camel_pieces(&chars, &mut out);
    letter_runs(&chars, &mut out);
    out
}

fn record(out: &mut BTreeMap<String, usize>, chars: &[char], start: usize, end: usize) {
    let token = chars[start..end].iter().collect::<String>().to_lowercase();
    let first = out.entry(token).or_insert(start);
    *first = (*first).min(start);
}

/// Python `[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+`, tried left to right.
fn camel_pieces(chars: &[char], out: &mut BTreeMap<String, usize>) {
    let upper = |i: usize| chars.get(i).is_some_and(char::is_ascii_uppercase);
    let lower = |i: usize| chars.get(i).is_some_and(char::is_ascii_lowercase);
    let mut i = 0;
    while i < chars.len() {
        let mut upper_end = i;
        while upper(upper_end) {
            upper_end += 1;
        }
        let end = if upper_end - i >= 2 && lower(upper_end) {
            upper_end - 1
        } else if (upper(i) && lower(i + 1)) || lower(i) {
            let mut end = if upper(i) { i + 1 } else { i };
            while lower(end) {
                end += 1;
            }
            end
        } else if upper_end > i {
            upper_end
        } else {
            i += 1;
            continue;
        };
        record(out, chars, i, end);
        i = end;
    }
}

/// Python `[^\W\d_]+`, lowercased.
fn letter_runs(chars: &[char], out: &mut BTreeMap<String, usize>) {
    let mut i = 0;
    while i < chars.len() {
        if is_letter_run(chars[i]) {
            let start = i;
            while i < chars.len() && is_letter_run(chars[i]) {
                i += 1;
            }
            record(out, chars, start, i);
        } else {
            i += 1;
        }
    }
}

/// Non-overlapping, case-insensitive matches of the alternatives, left to right; at each
/// position the first alternative that matches wins. Returns (alternative index, matched text,
/// start offset).
pub(crate) fn matches(text: &str, alternatives: &[Vec<MarkerPart>]) -> Vec<(usize, String, usize)> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let found = alternatives
            .iter()
            .enumerate()
            .find_map(|(index, parts)| match_at(&chars, i, parts).map(|end| (index, end)));
        match found {
            Some((index, end)) if end > i => {
                out.push((index, chars[i..end].iter().collect(), i));
                i = end;
            }
            _ => i += 1,
        }
    }
    out
}

fn match_at(chars: &[char], start: usize, parts: &[MarkerPart]) -> Option<usize> {
    let mut i = start;
    for part in parts {
        let ch = *chars.get(i)?;
        let ok = match part {
            MarkerPart::Digit => is_decimal(ch),
            MarkerPart::Char(expected) => ignorecase_eq(*expected, ch),
        };
        if !ok {
            return None;
        }
        i += 1;
    }
    Some(i)
}

/// Literal phrases as marker parts (case-insensitive, no digit placeholders).
pub(crate) fn literal_parts(phrase: &str) -> Vec<MarkerPart> {
    phrase.chars().map(MarkerPart::Char).collect()
}
