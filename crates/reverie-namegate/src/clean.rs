//! Normalisation and removal of exempt spans, in the reference order: NFKC, drop Cf, exempt
//! genuine PEM/DER bodies, blank allowlisted strings, drop long hex runs, blank the hex digits of
//! code escapes and short hex words, then strip base64-like blobs (which are returned so the
//! caller re-scans them).

use crate::classes::{is_format, is_space, is_word};
use unicode_normalization::UnicodeNormalization;

const PEM_LABELS: [&str; 7] = [
    "CERTIFICATE",
    "PUBLIC KEY",
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "CERTIFICATE REQUEST",
    "ENCRYPTED PRIVATE KEY",
];

/// Returns the cleaned text and the stripped blobs with their offsets in the cleaned text.
pub(crate) fn clean(text: &str, allow: &[String]) -> (String, Vec<(usize, String)>) {
    let normalized: String = text.nfkc().filter(|&ch| !is_format(ch)).collect();
    let mut cleaned = exempt_pem(&normalized);
    for entry in allow {
        cleaned = cleaned.replace(entry.as_str(), " ");
    }
    let cleaned = drop_hex(&cleaned);
    let cleaned = blank_code_hex(&cleaned);
    strip_blobs(&cleaned)
}

/// Replaces each PEM block whose body is strict base64 of a DER SEQUENCE (0x30, at least 16
/// bytes) with a space; every other block is left in place.
fn exempt_pem(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if let Some((end, body)) = pem_at(&chars, i) {
            if is_der_sequence(&body) {
                out.push(' ');
            } else {
                out.extend(&chars[i..end]);
            }
            i = end;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Matches `-----BEGIN <label>-----<body>-----END <label>-----` at `start`: the label is the
/// first in reference order followed by dashes, and the body (at least one character of
/// base64 alphabet, `=` or whitespace) runs to the first `-`, where the END marker must begin.
fn pem_at(chars: &[char], start: usize) -> Option<(usize, String)> {
    let mut i = literal_at(chars, start, "-----BEGIN ")?;
    let label = PEM_LABELS.iter().find(|label| {
        literal_at(chars, i, label).is_some_and(|after| literal_at(chars, after, "-----").is_some())
    })?;
    i = literal_at(chars, literal_at(chars, i, label)?, "-----")?;
    let body_start = i;
    while chars.get(i).is_some_and(|&ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=') || is_space(ch)
    }) {
        i += 1;
    }
    if i == body_start {
        return None;
    }
    let body: String = chars[body_start..i].iter().collect();
    let after_end = literal_at(chars, i, "-----END ")?;
    let after_label = literal_at(chars, after_end, label)?;
    let end = literal_at(chars, after_label, "-----")?;
    Some((end, body))
}

fn literal_at(chars: &[char], start: usize, literal: &str) -> Option<usize> {
    let mut i = start;
    for expected in literal.chars() {
        if chars.get(i) != Some(&expected) {
            return None;
        }
        i += 1;
    }
    Some(i)
}

fn is_der_sequence(body: &str) -> bool {
    let compact: String = body.chars().filter(|&ch| !is_space(ch)).collect();
    strict_base64(&compact).is_some_and(|der| der.len() >= 16 && der.first() == Some(&0x30))
}

/// Python `base64.b64decode(s, validate=True)`: alphabet only with at most two trailing `=`,
/// and the padding must agree with the data length. Trailing bits are ignored.
pub(crate) fn strict_base64(text: &str) -> Option<Vec<u8>> {
    let data = text.trim_end_matches('=');
    let padding = text.len() - data.len();
    if padding > 2
        || !data
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    {
        return None;
    }
    if !matches!((data.len() % 4, padding), (0, 0) | (2, 2) | (3, 1)) {
        return None;
    }
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for b in data.bytes() {
        buffer = (buffer << 6) | u32::from(sextet(b));
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buffer >> bits) & 0xff).ok()?);
        }
    }
    Some(out)
}

fn sextet(b: u8) -> u8 {
    match b {
        b'A'..=b'Z' => b - b'A',
        b'a'..=b'z' => b - b'a' + 26,
        b'0'..=b'9' => b - b'0' + 52,
        b'+' => 62,
        _ => 63,
    }
}

/// Python `\b[0-9a-fA-F]{16,}\b` replaced with a space: a maximal hex run of 16 or more whose
/// neighbours are not word characters.
fn drop_hex(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let end = run_end(&chars, i, |ch| ch.is_ascii_hexdigit());
        let before_ok = i == 0 || !is_word(chars[i - 1]);
        let after_ok = chars.get(end).is_none_or(|&ch| !is_word(ch));
        if end - i >= 16 && before_ok && after_ok {
            out.push(' ');
            i = end;
        } else if end > i {
            out.extend(&chars[i..end]);
            i = end;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Not part of the reference gate: hex digits that only look like letters. The digits of a `\u`
/// escape with exactly 4 hex digits, `\U` with 8 and `\x` with 2 become spaces, as does a letter
/// run with a decimal digit on both sides inside a hex word of 8 to 15 characters (bounded like
/// `drop_hex`) that holds a decimal digit. Hex digits are `0-9`, `a-f` and `A-F` in both rules.
/// Each is replaced one for one, so nothing else moves, and such digits never join a neighbouring
/// letter or form a token of their own. The only names this can hide are names spelled entirely
/// with the letters a to f, and only in those positions.
fn blank_code_hex(text: &str) -> String {
    let mut chars: Vec<char> = text.chars().collect();
    blank_escape_digits(&mut chars);
    blank_short_hex_words(&mut chars);
    chars.into_iter().collect()
}

fn blank_escape_digits(chars: &mut [char]) {
    let mut i = 0;
    while i + 1 < chars.len() {
        let width = match (chars[i], chars[i + 1]) {
            ('\\', 'u') => 4,
            ('\\', 'U') => 8,
            ('\\', 'x') => 2,
            _ => 0,
        };
        let digits = i + 2..i + 2 + width;
        if width > 0
            && digits.end <= chars.len()
            && chars[digits.clone()].iter().all(char::is_ascii_hexdigit)
        {
            chars[digits.clone()].fill(' ');
            i = digits.end;
        } else {
            i += 1;
        }
    }
}

fn blank_short_hex_words(chars: &mut [char]) {
    let mut i = 0;
    while i < chars.len() {
        let end = run_end(chars, i, |ch| ch.is_ascii_hexdigit());
        if end == i {
            i += 1;
            continue;
        }
        let bounded =
            (i == 0 || !is_word(chars[i - 1])) && chars.get(end).is_none_or(|&ch| !is_word(ch));
        if bounded && (8..16).contains(&(end - i)) && chars[i..end].iter().any(char::is_ascii_digit)
        {
            blank_interior_letters(&mut chars[i..end]);
        }
        i = end;
    }
}

/// Blanks every letter run of a hex word that has a decimal digit on both sides.
fn blank_interior_letters(word: &mut [char]) {
    let mut j = 0;
    while j < word.len() {
        let run = run_end(word, j, |ch| ch.is_ascii_alphabetic());
        if run == j {
            j += 1;
            continue;
        }
        if j > 0 && run < word.len() {
            word[j..run].fill(' ');
        }
        j = run;
    }
}

/// Python `[A-Za-z0-9+/]{32,}={0,2}`: runs of 32 or more with up to two `=`. Runs containing a
/// digit, a lowercase and an uppercase letter are blobs: blanked here and returned for re-scan.
fn strip_blobs(text: &str) -> (String, Vec<(usize, String)>) {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut blobs = Vec::new();
    let mut out_chars = 0;
    let mut i = 0;
    while i < chars.len() {
        let run = run_end(&chars, i, |ch| {
            ch.is_ascii_alphanumeric() || ch == '+' || ch == '/'
        });
        if run - i >= 32 {
            let mut end = run;
            while end < chars.len() && end - run < 2 && chars[end] == '=' {
                end += 1;
            }
            let candidate: String = chars[i..end].iter().collect();
            if is_blob(&candidate) {
                blobs.push((out_chars, candidate));
                out.push(' ');
                out_chars += 1;
            } else {
                out.push_str(&candidate);
                out_chars += end - i;
            }
            i = end;
        } else {
            let next = run.max(i + 1);
            out.extend(&chars[i..next]);
            out_chars += next - i;
            i = next;
        }
    }
    (out, blobs)
}

fn is_blob(candidate: &str) -> bool {
    candidate.bytes().any(|b| b.is_ascii_digit())
        && candidate.bytes().any(|b| b.is_ascii_lowercase())
        && candidate.bytes().any(|b| b.is_ascii_uppercase())
}

fn run_end(chars: &[char], start: usize, member: impl Fn(char) -> bool) -> usize {
    let mut end = start;
    while end < chars.len() && member(chars[end]) {
        end += 1;
    }
    end
}
