use sha2::{Digest, Sha256};

const SHIM: &str = "shim body = F1 r7 / native bridge r5 (shebang line excluded)";
const LEGACY_SHIM_HASH: &str = "d269adb515570c5188ef3752a6ae7abb57e8050b7fe39b8445967e814c3a79a2";

pub(super) fn d2(text: &str, jobs: u64) -> bool {
    let mut lines = text.split([
        '\n', '\r', '\u{b}', '\u{c}', '\u{1c}', '\u{1d}', '\u{1e}', '\u{85}', '\u{2028}',
        '\u{2029}',
    ]);
    if lines.clone().any(|line| line.starts_with("FAIL")) {
        return false;
    }
    let passes: Vec<_> = lines
        .by_ref()
        .filter_map(|line| line.strip_prefix("PASS "))
        .take(7)
        .collect();
    let [shim, other @ ..] = passes.as_slice() else {
        return false;
    };
    let expected = [
        "builder body = r5 (",
        "cargo resolves to the shim",
        &format!("shim sets CARGO_BUILD_JOBS={jobs}"),
        "REVERIE_NO_AUTOENV=1 untouched",
        "explicit -j left as given",
    ];
    other.len() == expected.len()
        && valid_shim(shim)
        && other
            .iter()
            .zip(expected)
            .all(|(line, prefix)| line.starts_with(prefix))
        && has_job_word(text, &format!("jobs={jobs}"))
}

fn valid_shim(shim: &str) -> bool {
    shim.starts_with(SHIM) || {
        let prefix: String = shim.chars().take(50).collect();
        format!("{:x}", Sha256::digest(prefix.as_bytes())) == LEGACY_SHIM_HASH
    }
}

fn has_job_word(text: &str, expression: &str) -> bool {
    text.match_indices(expression).any(|(offset, _)| {
        let before = text[..offset].chars().next_back();
        let after = text[offset + expression.len()..].chars().next();
        !before.is_some_and(word) && !after.is_some_and(word)
    })
}

fn word(character: char) -> bool {
    character == '_' || character.is_alphanumeric()
}

pub(super) fn can(text: &str) -> bool {
    text.split('\n').find_map(grep) == Some(("0", "1", "0"))
        && text
            .match_indices("jobs=")
            .find_map(|(start, _)| token(&text[start + 5..]))
            .is_some_and(|jobs| jobs.chars().all(python_digit))
        && text.split('\n').find_map(shims) == Some("/opt/reverie/autoenv/bin/cargo")
        && text.contains("CAN-DONE")
}

fn grep(line: &str) -> Option<(&str, &str, &str)> {
    let fields = line.strip_prefix("GREP pos=")?;
    let pos = token(fields)?;
    let fields = fields[pos.len()..].strip_prefix(" neg=")?;
    let neg = token(fields)?;
    let fields = fields[neg.len()..].strip_prefix(" find=")?;
    Some((pos, neg, token(fields)?))
}

fn shims(line: &str) -> Option<&str> {
    let fields = line.strip_prefix("SHIMS ")?;
    let cargo = token(fields)?;
    token(fields[cargo.len()..].strip_prefix(' ')?)?;
    Some(cargo)
}

fn token(text: &str) -> Option<&str> {
    let token = text.split(char::is_whitespace).next()?;
    (!token.is_empty()).then_some(token)
}

fn python_digit(character: char) -> bool {
    crate::rootless::is_digit(u32::from(character))
}
