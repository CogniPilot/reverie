//! Decode the Hands journal function call and bound its model-visible replay.

use super::command_line;
use crate::legacy_json::{Node, decode_python_str};
use reverie_core::{memory::quoted_memory_text, python_lowercase_string};
use serde::Serialize;
use serde_json::{
    json,
    value::{RawValue, to_raw_value},
};

const ARGUMENT_BYTES: usize = 8192;
const REPLAY_BYTES: usize = 1024;

#[derive(Serialize)]
pub struct JournalCommand {
    replay: String,
    #[serde(flatten)]
    outcome: Outcome,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Outcome {
    Parsed(Operation),
    Refused { error: String },
}

#[derive(Serialize)]
#[serde(tag = "name", content = "arguments", rename_all = "snake_case")]
enum Operation {
    Help { topic: String },
    JournalCommit(Draft),
    JournalMap { query: String },
    JournalRecall { query: String },
    JournalReceipt { turn_id: String },
    JournalSource { message_id: String },
}

/// A decoded journal command ready for the turn policy.
pub enum JournalAction {
    Help(String),
    Dispatch(Box<RawValue>),
}

impl JournalCommand {
    /// Decode the existing model arguments. Replay is kept even for a
    /// syntactically valid command that the journal will refuse.
    pub fn decode(raw: &[u8]) -> Self {
        let line = command_string(raw);
        let replay = line
            .as_ref()
            .map_or_else(|_| "{}".into(), |text| replay(text));
        let parsed = if raw.len() > ARGUMENT_BYTES {
            Err("bounded JSON arguments required".into())
        } else {
            line.and_then(|line| parse(&line))
        };
        let outcome = match parsed {
            Ok(operation) => Outcome::Parsed(operation),
            Err(error) => Outcome::Refused { error },
        };
        Self { replay, outcome }
    }

    pub fn resolve(self) -> (String, Result<JournalAction, String>) {
        let action = match self.outcome {
            Outcome::Parsed(Operation::Help { topic }) => Ok(JournalAction::Help(topic)),
            Outcome::Parsed(operation) => to_raw_value(&operation)
                .map(JournalAction::Dispatch)
                .map_err(|_| "invalid journal arguments".to_owned()),
            Outcome::Refused { error } => Err(error),
        };
        (self.replay, action)
    }
}

fn command_string(raw: &[u8]) -> Result<String, String> {
    let decoded = decode_python_str(raw).map_err(|_| "invalid JSON arguments")?;
    let Node::Object(fields) = &decoded.0 else {
        return Err("a command string is required".into());
    };
    if fields.len() == 1
        && let Some((key, value)) = fields.iter().next()
        && key.equals_ascii("command")
        && let Some(line) = super::scalar(value)
    {
        return Ok(line);
    }
    Err("a command string is required".into())
}

fn replay(text: &str) -> String {
    let command = if text.len() > REPLAY_BYTES {
        format!(
            "{} [truncated]",
            &text[..text.floor_char_boundary(REPLAY_BYTES)]
        )
    } else {
        text.to_owned()
    };
    json!({ "command": command }).to_string()
}

fn parse(line: &str) -> Result<Operation, String> {
    let mut words = command_line::split(line)?.into_iter();
    let verb = words.next().ok_or("empty command")?;
    let rest = words.as_slice();
    match python_lowercase_string(&verb).as_str() {
        "help" => match rest {
            [] => Ok(Operation::Help {
                topic: String::new(),
            }),
            [topic] => Ok(Operation::Help {
                topic: topic.clone(),
            }),
            _ => Err("help takes at most one command name".into()),
        },
        "recall" if rest.is_empty() => Err("recall needs search words".into()),
        "recall" => Ok(Operation::JournalRecall {
            query: rest.join(" "),
        }),
        "map" => Ok(Operation::JournalMap {
            query: rest.join(" "),
        }),
        "source" => match rest {
            [message_id] => Ok(Operation::JournalSource {
                message_id: message_id.clone(),
            }),
            _ => Err("source takes exactly one ID".into()),
        },
        "receipt" => match rest {
            [turn_id] => Ok(Operation::JournalReceipt {
                turn_id: turn_id.clone(),
            }),
            _ => Err("receipt takes exactly one ID".into()),
        },
        "save" => Ok(Operation::JournalCommit(parse_draft(rest)?)),
        unknown => Err(format!("unknown command {}", repr(unknown))),
    }
}

#[derive(Default, Serialize)]
struct Draft {
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    tags: Vec<String>,
    sources: Vec<Source>,
    #[serde(skip_serializing_if = "Annotations::empty")]
    annotations: Annotations,
}

#[derive(Serialize)]
struct Source {
    id: String,
    quote: String,
}

#[derive(Default, Serialize)]
struct Annotations {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    topics: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    importance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    provenance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    supersedes: Vec<Box<RawValue>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    related: Vec<Box<RawValue>>,
}

impl Annotations {
    fn empty(&self) -> bool {
        self.topics.is_empty()
            && self.importance.is_none()
            && self.provenance.is_none()
            && self.reason.is_none()
            && self.supersedes.is_empty()
            && self.related.is_empty()
    }
}

fn parse_draft(mut rest: &[String]) -> Result<Draft, String> {
    let mut draft = Draft::default();
    while let Some((flag, args)) = rest.split_first() {
        let width = if flag == "--source" { 2 } else { 1 };
        let Some((args, remaining)) = args.split_at_checked(width) else {
            return Err(format!("{flag} needs {width} value(s)"));
        };
        if args.iter().any(|arg| arg.starts_with("--")) {
            return Err(format!("{flag} needs {width} value(s)"));
        }
        draft.add_flag(flag, args)?;
        rest = remaining;
    }
    Ok(draft)
}

impl Draft {
    fn add_flag(&mut self, flag: &str, args: &[String]) -> Result<(), String> {
        let value = &args[0];
        let annotations = &mut self.annotations;
        match flag {
            "--text" if self.text.is_none() => self.text = Some(value.clone()),
            "--tag" => self.tags.push(value.clone()),
            "--source" => self.sources.push(Source {
                id: value.clone(),
                quote: args[1].clone(),
            }),
            "--topic" => annotations.topics.push(value.clone()),
            "--importance" if annotations.importance.is_none() => {
                annotations.importance = Some(value.clone())
            }
            "--provenance" if annotations.provenance.is_none() => {
                annotations.provenance = Some(value.clone())
            }
            "--reason" if annotations.reason.is_none() => annotations.reason = Some(value.clone()),
            "--supersedes" => annotations.supersedes.push(integer(value)?),
            "--related" => annotations.related.push(integer(value)?),
            _ => return Err(format!("unknown or repeated option {flag}")),
        }
        Ok(())
    }
}

fn repr(text: &str) -> String {
    quoted_memory_text(&text.chars().map(u32::from).collect::<Vec<_>>()).expect("UTF-8 text")
}

fn integer(value: &str) -> Result<Box<RawValue>, String> {
    let points: Vec<_> = value.chars().map(u32::from).collect();
    let (negative, magnitude) = crate::rootless::parse_python_integer(&points)
        .ok_or_else(|| format!("invalid literal for int() with base 10: {}", repr(value)))?;
    let sign = if negative { "-" } else { "" };
    Ok(RawValue::from_string(format!("{sign}{}", magnitude.as_str())).expect("decimal integer"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn decode(raw: &str) -> Value {
        serde_json::from_slice(
            &serde_json::to_vec(&JournalCommand::decode(raw.as_bytes())).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn save_preserves_order_quotes_and_decimal_references() {
        let line = r#"SAVE --text 'A "lantern" 🐦' --tag first --tag second --source id "exact quote" --topic Identity --supersedes 2_000 --related ٤ --reason "from a receipt""#;
        let raw = json!({ "command": line }).to_string();
        let reply = decode(&raw);
        assert_eq!(
            reply,
            json!({
                "name": "journal_commit",
                "replay": raw,
                "arguments": {
                    "text": "A \"lantern\" 🐦", "tags": ["first", "second"],
                    "sources": [{"id": "id", "quote": "exact quote"}],
                    "annotations": {
                        "topics": ["Identity"], "supersedes": [2000],
                        "related": [4], "reason": "from a receipt"
                    }
                }
            }),
        );
    }

    #[test]
    fn refuses_malformed_commands_and_keeps_safe_replay() {
        for (command, error) in [
            (
                "save --source missing --tag lesson",
                "--source needs 2 value(s)",
            ),
            (
                "save --text one --text two",
                "unknown or repeated option --text",
            ),
            (
                "save --related 1__0",
                "invalid literal for int() with base 10: '1__0'",
            ),
            ("source 1 2", "source takes exactly one ID"),
            ("receipt", "receipt takes exactly one ID"),
            ("help save now", "help takes at most one command name"),
            ("recall", "recall needs search words"),
            (r#"recall "open"#, "No closing quotation"),
            ("recall slash\\", "No escaped character"),
        ] {
            let raw = json!({ "command": command }).to_string();
            assert_eq!(decode(&raw), json!({ "replay": raw, "error": error }));
        }
        assert_eq!(decode("[]")["replay"], "{}");
        assert_eq!(decode(r#"{"command":"help","extra":true}"#)["replay"], "{}");
        assert_eq!(decode("broken")["error"], "invalid JSON arguments");
    }

    #[test]
    fn retains_literal_punctuation_and_cuts_replay_at_a_utf8_boundary() {
        let raw = json!({ "command": r#"recall '' #literal and\ a "\$quote""# }).to_string();
        let result = decode(&raw);
        assert_eq!(
            result["arguments"],
            json!({"query": r#" #literal and a \$quote"#})
        );
        let command = format!("recall {}", "雪".repeat(4000));
        let raw = json!({"command": command}).to_string();
        let result = decode(&raw);
        let replay: Value = serde_json::from_str(result["replay"].as_str().unwrap()).unwrap();
        let command = replay["command"].as_str().unwrap();
        assert_eq!(command, format!("recall {} [truncated]", "雪".repeat(339)));
        assert_eq!(result["error"], "bounded JSON arguments required");
    }
}
