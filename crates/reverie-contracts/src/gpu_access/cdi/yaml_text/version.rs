//! PyYAML accepts any nonnegative minor version when major==1. Libyaml's
//! parser accepts only 1.1/1.2 and its scanner bounds version numbers to nine
//! digits. Normalize ONLY an actual directive identified by that parser's
//! failure mark, never a lookalike scalar, comment or block-literal line.
use crate::legacy_json::DEFAULT_INT_MAX_DIGITS;
use libyaml_safer::Error;
pub(super) fn correct(raw: &mut String, error: &Error) -> bool {
    if error.problem() == "found unknown directive name" {
        return ignore_unknown(raw, error);
    }
    let mark = if error.problem() == "found incompatible YAML document" {
        error.problem_mark()
    } else if error.context() == Some("while scanning a %YAML directive") {
        error.context_mark()
    } else {
        return false;
    };
    let Some(mark) = mark else {
        return false;
    };
    let Some(start) = line_start(raw, mark.line) else {
        return false;
    };
    let line = &raw[start..];
    let line = line.strip_prefix('\u{feff}').unwrap_or(line);
    let bom_offset = raw[start..].len() - line.len();
    let Some(tail) = line.strip_prefix("%YAML ") else {
        return false;
    };
    let tail = tail.trim_start_matches(' ');
    let Some(dot) = tail.find('.') else {
        return false;
    };
    let major = &tail[..dot];
    let minor_len = tail[dot + 1..]
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    let minor = &tail[dot + 1..dot + 1 + minor_len];
    if !tail[dot + 1 + minor_len..]
        .chars()
        .next()
        .is_none_or(directive_delimiter)
    {
        return false;
    }
    if major.is_empty()
        || minor.is_empty()
        || major.len() > DEFAULT_INT_MAX_DIGITS
        || minor.len() > DEFAULT_INT_MAX_DIGITS
        || !major.bytes().all(|byte| byte.is_ascii_digit())
        || major.trim_start_matches('0') != "1"
    {
        return false;
    }
    let offset = start + bom_offset + line.len() - tail.len();
    let end = offset + dot + 1 + minor_len;
    if &raw[offset..end] == "1.1" {
        return false;
    }
    raw.replace_range(offset..end, "1.1");
    true
}
/// Tokens identify real directives, including directives following comments or
/// BOM. Python's scanner permits ASCII spaces, whereas libyaml also accepts
/// tabs around version/TAG values. Comments themselves may contain tabs.
pub(super) fn token_valid(raw: &str, token: &libyaml_safer::Token) -> bool {
    if !matches!(
        token.data,
        libyaml_safer::TokenData::VersionDirective { .. }
            | libyaml_safer::TokenData::TagDirective { .. }
    ) {
        return true;
    }
    let start = usize::try_from(token.start_mark.index).expect("input bounded by usize");
    let end = usize::try_from(token.end_mark.index).expect("input bounded by usize");
    let Some(value) = raw.get(start..end) else {
        return false;
    };
    if value.contains('\t') {
        return false;
    }
    let tail = raw[end..].trim_start_matches(' ');
    tail.starts_with('#') || tail.chars().next().is_none_or(line_break)
}
fn ignore_unknown(raw: &mut String, error: &Error) -> bool {
    let Some(start) = error
        .context_mark()
        .and_then(|mark| line_start(raw, mark.line))
    else {
        return false;
    };
    let prefix = raw[start..]
        .strip_prefix('\u{feff}')
        .map_or(0, |tail| raw[start..].len() - tail.len());
    let start = start + prefix;
    let Some(tail) = raw[start..].strip_prefix('%') else {
        return false;
    };
    let count = tail
        .bytes()
        .take_while(|point| point.is_ascii_alphanumeric() || matches!(point, b'-' | b'_'))
        .count();
    if count == 0 || !tail[count..].chars().next().is_none_or(directive_delimiter) {
        return false;
    }
    let end = raw[start..]
        .find(line_break)
        .map_or(raw.len(), |offset| start + offset);
    // A fresh, unused TAG token preserves the parser's explicit-document-start
    // requirement and directive placement. Its ASCII handle cannot occur in
    // the original document, so it cannot change any node's tag resolution.
    // Preserve ignored source bytes as comment data for the reader's checks.
    let mut number = 0;
    let handle = loop {
        let handle = format!("!reverieIgnored{number}!");
        if !raw.contains(&handle) {
            break handle;
        }
        number += 1;
    };
    let replacement = format!("%TAG {handle} tag:reverie.invalid/ #{}", &raw[start..end]);
    raw.replace_range(start..end, &replacement);
    true
}
fn directive_delimiter(point: char) -> bool {
    point == ' ' || line_break(point)
}
fn line_break(point: char) -> bool {
    matches!(
        point,
        '\0' | '\r' | '\n' | '\u{85}' | '\u{2028}' | '\u{2029}'
    )
}
fn line_start(raw: &str, selected: u64) -> Option<usize> {
    let mut line = 0;
    let mut previous_cr = false;
    for (index, point) in raw.char_indices() {
        if line == selected {
            if point == '\n' && previous_cr {
                previous_cr = false;
                continue;
            }
            return Some(index);
        }
        if matches!(point, '\r' | '\n' | '\u{85}' | '\u{2028}' | '\u{2029}')
            && !(point == '\n' && previous_cr)
        {
            line += 1;
        }
        previous_cr = point == '\r';
    }
    (line == selected).then_some(raw.len())
}
