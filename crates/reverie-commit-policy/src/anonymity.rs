//! Agent-name anonymity: whole-word, case-sensitive names in commit or pull request text and in
//! the added lines of a unified diff, minus owner-allowed paths.

use crate::glob::fnmatchcase;
use crate::py::{self, truthy};
use crate::{Error, policy_error};
use serde_json::{Map, Value};

/// One name found in text or in an added diff line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    /// `message` for text, otherwise the diff path.
    pub place: String,
    /// 1-based line in the text, or the new-file line number in the diff.
    pub line: usize,
    /// The configured name that matched.
    pub name: String,
}

/// The owner's names, longest first, or `None` when the rule is off.
#[derive(Debug)]
pub struct Names(Vec<Vec<char>>);

impl Names {
    /// Reads `agent_anonymity.agent_names`, trimming entries and ignoring blank or non-string ones.
    ///
    /// # Errors
    /// [`Error::Malformed`] when the rule or its name list has the wrong shape.
    pub fn from_policy(policy: &Map<String, Value>) -> Result<Option<Self>, Error> {
        let rule = rule(policy)?;
        let names = match rule.get("agent_names") {
            None => return Ok(None),
            Some(Value::Array(items)) => items,
            Some(_) => return Err(Error::Malformed("agent_names must be a list".into())),
        };
        let mut unique: Vec<Vec<char>> = names
            .iter()
            .filter_map(Value::as_str)
            .map(py::strip)
            .filter(|name| !name.is_empty())
            .map(|name| name.chars().collect())
            .collect();
        unique.sort();
        unique.dedup();
        unique.sort_by_key(|name| std::cmp::Reverse(name.len()));
        Ok((!unique.is_empty()).then_some(Self(unique)))
    }

    /// Non-overlapping matches in one line, left to right, trying longer names first at each
    /// position; a name counts only between characters outside `[A-Za-z0-9_]`.
    fn find(&self, line: &str) -> Vec<String> {
        let text: Vec<char> = line.chars().collect();
        let mut found = Vec::new();
        let mut at = 0;
        while at < text.len() {
            if at > 0 && word(text[at - 1]) {
                at += 1;
                continue;
            }
            let hit = self.0.iter().find(|name| {
                text[at..].starts_with(name)
                    && text.get(at + name.len()).is_none_or(|&ch| !word(ch))
            });
            match hit {
                Some(name) => {
                    found.push(name.iter().collect());
                    at += name.len();
                }
                None => at += 1,
            }
        }
        found
    }
}

fn word(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn rule(policy: &Map<String, Value>) -> Result<Map<String, Value>, Error> {
    match policy.get("agent_anonymity") {
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(value) if !truthy(Some(value)) => Ok(Map::new()),
        None => Ok(Map::new()),
        Some(_) => Err(Error::Malformed("agent_anonymity must be an object".into())),
    }
}

/// Names in each line of `text`, reported at `place`.
fn text_violations(text: &str, names: &Names, place: &str) -> Vec<Violation> {
    py::splitlines(text)
        .into_iter()
        .enumerate()
        .flat_map(|(index, line)| {
            names.find(line).into_iter().map(move |name| Violation {
                place: place.to_owned(),
                line: index + 1,
                name,
            })
        })
        .collect()
}

/// `(path, new line number, text)` for every added line of a unified diff. Hunk headers give
/// exact line counts, so an added line whose own text starts with `++` or `diff --git` is never
/// mistaken for a file header. A deleted file's lines have no path.
///
/// # Errors
/// [`Error::Policy`] for a hunk header that cannot be parsed.
pub fn added_lines(diff: &str) -> Result<Vec<(Option<String>, usize, String)>, Error> {
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    let (mut old, mut new, mut number) = (0_usize, 0_usize, 0_usize);
    for line in py::splitlines(diff) {
        if old > 0 || new > 0 {
            if let Some(text) = line.strip_prefix('+') {
                out.push((path.clone(), number, text.to_owned()));
                number += 1;
                new = new.saturating_sub(1);
            } else if line.starts_with('-') {
                old = old.saturating_sub(1);
            } else if line.starts_with(' ') {
                number += 1;
                old = old.saturating_sub(1);
                new = new.saturating_sub(1);
            }
            continue;
        }
        if line.starts_with("diff --git ") {
            path = None;
        } else if let Some(target) = line.strip_prefix("+++ ") {
            path = (target != "/dev/null")
                .then(|| target.strip_prefix("b/").unwrap_or(target).to_owned());
        } else if line.starts_with("@@") {
            (old, number, new) = hunk(line).ok_or_else(|| {
                let shown: String = line.chars().take(80).collect();
                policy_error(&format!("unparseable diff hunk header: {shown}"))
            })?;
        }
    }
    Ok(out)
}

/// `@@ -A[,B] +C[,D] @@` at the start of a line: (old count, first new line, new count).
fn hunk(line: &str) -> Option<(usize, usize, usize)> {
    let rest = line.strip_prefix("@@ -")?;
    let (_, rest) = digits(rest)?;
    let (old, rest) = count(rest)?;
    let rest = rest.strip_prefix(" +")?;
    let (start, rest) = digits(rest)?;
    let (new, rest) = count(rest)?;
    rest.starts_with(" @@").then_some((old, start, new))
}

/// An optional `,N` count, 1 when absent.
fn count(text: &str) -> Option<(usize, &str)> {
    match text.strip_prefix(',') {
        Some(rest) => digits(rest),
        None => Some((1, text)),
    }
}

/// One or more ASCII digits. git writes ASCII; any other digit is refused as unparseable.
fn digits(text: &str) -> Option<(usize, &str)> {
    let end = text
        .find(|ch: char| !ch.is_ascii_digit())
        .unwrap_or(text.len());
    let value = text[..end].parse().ok()?;
    Some((value, &text[end..]))
}

/// Agent names in a message (or pull request text) and in the added lines of a diff, minus the
/// rule's `allow_paths`. Empty when the rule is off.
///
/// # Errors
/// [`Error::Malformed`] for an unusable rule; [`Error::Policy`] for an unparseable diff.
pub fn violations(
    policy: &Map<String, Value>,
    message: Option<&str>,
    diff: Option<&str>,
) -> Result<Vec<Violation>, Error> {
    let Some(names) = Names::from_policy(policy)? else {
        return Ok(Vec::new());
    };
    let allowed: Vec<String> = match rule(policy)?.get("allow_paths") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| Error::Malformed("allow_paths must be strings".into()))
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(Error::Malformed("allow_paths must be a list".into())),
    };
    let mut found = match message {
        Some(text) if !text.is_empty() => text_violations(text, &names, "message"),
        _ => Vec::new(),
    };
    for (path, line, text) in added_lines(diff.unwrap_or_default())? {
        let Some(path) = path else { continue };
        if allowed.iter().any(|glob| fnmatchcase(&path, glob)) {
            continue;
        }
        found.extend(names.find(&text).into_iter().map(|name| Violation {
            place: path.clone(),
            line,
            name,
        }));
    }
    Ok(found)
}

/// Refuses any violation, naming up to ten of them.
///
/// # Errors
/// [`Error::Policy`] listing the names found; see [`violations`] for the others.
pub fn check(
    policy: &Map<String, Value>,
    message: Option<&str>,
    diff: Option<&str>,
) -> Result<(), Error> {
    let found = violations(policy, message, diff)?;
    if found.is_empty() {
        return Ok(());
    }
    let shown: Vec<String> = found
        .iter()
        .take(10)
        .map(|v| format!("{}:{} {}", v.place, v.line, v.name))
        .collect();
    let more = if found.len() > 10 {
        format!(" (+{} more)", found.len() - 10)
    } else {
        String::new()
    };
    Err(policy_error(&format!(
        "agent names are not allowed by owner policy (agent_anonymity): {}{more}",
        shown.join("; ")
    )))
}
