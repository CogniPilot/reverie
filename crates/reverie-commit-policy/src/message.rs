//! Commit message rules: a DCO `Signed-off-by` trailer and no AI co-author trailers.

use crate::py::{self, ignorecase_eq, truthy};
use crate::{Error, policy_error};
use serde_json::{Map, Value};

const SIGNOFF: &str = "Signed-off-by: ";

/// One line of `^Signed-off-by: .+ <[^<>\s]+@[^<>\s]+>$` under `re.M`, where only `\n` ends a
/// line. The address cannot contain `<`, so it starts after the last `<` of the line.
fn dco_line(line: &str) -> bool {
    let Some(rest) = line
        .strip_prefix(SIGNOFF)
        .and_then(|rest| rest.strip_suffix('>'))
    else {
        return false;
    };
    let Some(open) = rest.rfind('<') else {
        return false;
    };
    let (name, address) = (&rest[..open], &rest[open + 1..]);
    let Some(name) = name.strip_suffix(' ') else {
        return false;
    };
    let chars: Vec<char> = address.chars().collect();
    !name.is_empty()
        && chars
            .iter()
            .all(|&ch| ch != '<' && ch != '>' && !py::is_space(ch))
        && chars.len() >= 3
        && chars[1..chars.len() - 1].contains(&'@')
}

/// A configured author pattern. Only literal patterns are supported (backslash escapes a
/// punctuation character); any other regular-expression syntax is refused, never guessed.
fn literal(pattern: &str) -> Result<Vec<char>, Error> {
    let refuse = || {
        Error::Malformed(
            "ai_author_patterns supports literal text with backslash-escaped punctuation only"
                .into(),
        )
    };
    let mut out = Vec::new();
    let mut chars = pattern.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => match chars.next() {
                Some(next) if next.is_ascii_punctuation() => out.push(next),
                _ => return Err(refuse()),
            },
            '.' | '^' | '$' | '*' | '+' | '?' | '{' | '}' | '[' | ']' | '|' | '(' | ')' => {
                return Err(refuse());
            }
            _ if !ch.is_ascii() => return Err(refuse()),
            _ => out.push(ch),
        }
    }
    Ok(out)
}

/// `re.search(pattern, line, re.I)` for a literal pattern.
fn search(pattern: &[char], line: &str) -> bool {
    let text: Vec<char> = line.chars().collect();
    pattern.is_empty()
        || text.windows(pattern.len()).any(|window| {
            window
                .iter()
                .zip(pattern)
                .all(|(&ch, &want)| ignorecase_eq(want, ch))
        })
}

/// The configured author patterns. There is no built-in list: the owner names them in the policy
/// or in a pinned private author list, and `no_ai_coauthors` without them is refused.
fn patterns(commits: &Map<String, Value>) -> Result<Vec<Vec<char>>, Error> {
    match commits.get("ai_author_patterns") {
        None => Err(Error::Malformed(
            "no_ai_coauthors needs ai_author_patterns from the policy or a pinned author list"
                .into(),
        )),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(pattern) => literal(pattern),
                _ => Err(Error::Malformed(
                    "ai_author_patterns must be strings".into(),
                )),
            })
            .collect(),
        Some(_) => Err(Error::Malformed("ai_author_patterns must be a list".into())),
    }
}

/// Whether a configured trailer key is a plain token (ASCII letters, digits and hyphens), so its
/// case-insensitive comparison is the same under any lowercasing.
pub(crate) fn trailer_key(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The trailer keys the author patterns apply to, as lowercase `key:` prefixes.
fn trailers(commits: &Map<String, Value>) -> Result<Vec<String>, Error> {
    let keys = match commits.get("ai_author_trailers") {
        None => {
            return Err(Error::Malformed(
                "no_ai_coauthors needs ai_author_trailers from the policy or a pinned author list"
                    .into(),
            ));
        }
        Some(Value::Array(items)) => items,
        Some(_) => return Err(Error::Malformed("ai_author_trailers must be a list".into())),
    };
    if keys.is_empty() {
        return Err(Error::Malformed(
            "ai_author_trailers must name at least one trailer".into(),
        ));
    }
    keys.iter()
        .map(|key| match key {
            Value::String(key) if trailer_key(key) => Ok(format!("{}:", key.to_ascii_lowercase())),
            _ => Err(Error::Malformed(
                "ai_author_trailers must be trailer keys (letters, digits and hyphens)".into(),
            )),
        })
        .collect()
}

/// The policy's `commits` object (empty when absent).
pub(crate) fn commits(policy: &Map<String, Value>) -> Result<Map<String, Value>, Error> {
    match policy.get("commits") {
        None => Ok(Map::new()),
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(_) => Err(Error::Malformed("commits must be an object".into())),
    }
}

/// Checks one commit message against the policy's `commits` rules.
///
/// # Errors
/// [`Error::Policy`] when a rule refuses the message; [`Error::Malformed`] for an unusable policy.
pub fn valid_message(message: &str, policy: &Map<String, Value>) -> Result<(), Error> {
    let commits = commits(policy)?;
    if truthy(commits.get("dco_signoff")) && !message.split('\n').any(dco_line) {
        return Err(policy_error(
            "a DCO Signed-off-by trailer is required; use git commit -s",
        ));
    }
    if truthy(commits.get("no_ai_coauthors")) {
        let patterns = patterns(&commits)?;
        let trailers = trailers(&commits)?;
        let refused = py::splitlines(message).into_iter().any(|line| {
            let lower = line.to_lowercase();
            trailers.iter().any(|key| lower.starts_with(key.as_str()))
                && patterns.iter().any(|pattern| search(pattern, line))
        });
        if refused {
            return Err(policy_error(
                "AI co-author trailers are disabled by owner policy",
            ));
        }
    }
    Ok(())
}
