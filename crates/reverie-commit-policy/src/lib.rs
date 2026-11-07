//! Owner standing-policy rules for commits and pull requests: DCO sign-off and no AI co-author
//! trailers in messages, agent-name anonymity over messages and added diff lines, review receipts
//! pinned to the exact tree or head, and the automatic-merge decision.
//!
//! Semantics follow the reviewed Python reference (`reverie.governance`) exactly, including
//! Python line splitting, case folding, truthiness and equality, with deliberate narrowings that
//! refuse instead of guessing: `ai_author_patterns` must be literal text, list-valued policy fields
//! must be JSON lists, and `no_ai_coauthors` has no built-in author list. The trailer keys and
//! author patterns it checks come from the owner's policy or a pinned private [`AuthorList`].
//! Nothing here performs network calls or merges.

mod anonymity;
mod authors;
mod glob;
mod message;
mod py;
mod review;

pub use anonymity::{Names, Violation, added_lines, check as check_anonymity, violations};
pub use authors::{AUTHOR_LIST_SCHEMA, AuthorList};
pub use message::valid_message;
pub use review::{
    Decision, Staged, check_commit, check_review, directive_ids, merge_decision, review_context,
};

use serde_json::Value;
use std::fmt;

/// Why a check did not pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The policy refuses the change; the text is the reference wording.
    Policy(String),
    /// The policy, receipt or snapshot has a shape the rules cannot use.
    Malformed(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Policy(reason) | Self::Malformed(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for Error {}

pub(crate) fn policy_error(reason: &str) -> Error {
    Error::Policy(reason.to_owned())
}

/// Python `json.dumps` with default settings: `", "` and `": "` separators and ASCII-only
/// output, for objects given as ordered fields.
#[must_use]
pub fn dumps_fields(fields: &[(&str, Value)]) -> String {
    let body: Vec<String> = fields
        .iter()
        .map(|(key, value)| format!("{}: {}", string(key), dumps(value)))
        .collect();
    format!("{{{}}}", body.join(", "))
}

/// Python `json.dumps` of one value (objects in key order).
#[must_use]
pub fn dumps(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => string(text),
        Value::Array(items) => {
            let items: Vec<String> = items.iter().map(dumps).collect();
            format!("[{}]", items.join(", "))
        }
        Value::Object(map) => {
            let fields: Vec<(&str, Value)> = map
                .iter()
                .map(|(key, value)| (key.as_str(), value.clone()))
                .collect();
            dumps_fields(&fields)
        }
    }
}

fn string(text: &str) -> String {
    let mut out = String::from('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ' '..='~' => out.push(ch),
            _ => {
                let mut units = [0_u16; 2];
                for unit in ch.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests;
