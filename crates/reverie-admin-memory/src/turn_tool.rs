//! Model-facing journal tool metadata and bounded per-turn dispatch.

use reverie_contracts::memory::channel::journal::{JournalAction, JournalCommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use std::io;

mod help;

const MAX_CALLS: usize = 3;
const TRANSPORT_ARGUMENT_BYTES: usize = 50_000;
pub(super) const CONTEXT_CHARS: usize = 4800;
pub(super) const RESULT_CHARS: usize = 2400;
pub(super) const TURN_RESERVE: usize = CONTEXT_CHARS + MAX_CALLS * (RESULT_CHARS + 1500) + 2400;
const COMMANDS: &[(&str, &str)] = &[
    ("save", "journal_commit"),
    ("recall", "journal_recall"),
    ("source", "journal_source"),
    ("receipt", "journal_receipt"),
    ("map", "journal_map"),
];

#[derive(Serialize)]
pub(super) struct Toolset {
    tools: [Value; 1],
    offered: Vec<&'static str>,
    call_limit: usize,
    accepted_calls: Vec<&'static str>,
}

pub(super) fn toolset(read_only: bool, needs_reason: bool) -> Toolset {
    let enabled = COMMANDS
        .iter()
        .filter(|(verb, _)| !read_only || *verb != "save");
    let commands = enabled
        .clone()
        .map(|(verb, _)| *verb)
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if read_only {
        " save is unavailable this turn: read-only request."
    } else if needs_reason {
        " save needs --reason this turn: nobody asked you to remember anything and no reminder is due."
    } else {
        ""
    };
    let description = format!(
        "Your journal for this room, as one command line. Commands: {commands}, help. Run help (free once per turn) or help COMMAND for usage.{suffix}"
    );
    Toolset {
        tools: [json!({"type": "function", "function": {
            "name": "journal",
            "description": description,
            "parameters": {"type": "object", "additionalProperties": false,
                "properties": {"command": {"type": "string", "maxLength": 4096,
                    "description": "For example: recall lantern crown, or: help save"}},
                "required": ["command"]},
        }})],
        offered: enabled.map(|(_, name)| *name).collect(),
        call_limit: MAX_CALLS,
        accepted_calls: std::iter::once("journal")
            .chain(COMMANDS.iter().map(|(_, name)| *name))
            .collect(),
    }
}

#[derive(Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum Request {
    Invoke {
        read_only: bool,
        state: CallState,
        name: Option<String>,
        arguments: Option<String>,
    },
    Merge {
        recall: String,
        existing: String,
        context: String,
        max_chars: usize,
    },
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct CallState {
    pub(super) calls: usize,
    help_shown: bool,
}

#[derive(Serialize)]
pub(super) struct Step {
    pub(super) state: CallState,
    pub(super) replay: String,
    #[serde(flatten)]
    pub(super) outcome: Outcome,
}

#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum Outcome {
    Reply { reply: Value },
    Dispatch { dispatch: Dispatch },
}

#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum Dispatch {
    Parsed(Box<RawValue>),
    Raw {
        name: String,
        arguments: Option<String>,
    },
}

pub(crate) fn execute(bytes: &[u8]) -> io::Result<Box<RawValue>> {
    use serde_json::value::to_raw_value;
    Ok(match serde_json::from_slice::<Request>(bytes)? {
        Request::Invoke {
            read_only,
            state,
            name,
            arguments,
        } => to_raw_value(&invoke(read_only, state, name, arguments))?,
        Request::Merge {
            recall,
            existing,
            context,
            max_chars,
        } => to_raw_value(&merge(recall, existing, &context, max_chars)?)?,
    })
}

pub(super) fn invoke(
    read_only: bool,
    state: CallState,
    name: Option<String>,
    arguments: Option<String>,
) -> Step {
    let mut step = Step {
        state,
        replay: "{}".into(),
        outcome: refused("turn_budget"),
    };
    if step.state.calls >= MAX_CALLS {
        return step;
    }
    step.outcome = if name.as_deref() == Some("journal") {
        step.command(arguments.as_deref(), read_only)
    } else {
        step.state.calls += 1;
        match name.filter(|name| COMMANDS.iter().any(|(_, tool)| name == tool)) {
            Some(name) => Outcome::Dispatch {
                dispatch: Dispatch::Raw { name, arguments },
            },
            None => refused(
                "invalid_arguments_or_source; compress text and use exact source IDs/quotes",
            ),
        }
    };
    step
}

impl Step {
    fn command(&mut self, arguments: Option<&str>, read_only: bool) -> Outcome {
        let Some(raw) = arguments.filter(|raw| raw.len() <= TRANSPORT_ARGUMENT_BYTES) else {
            return self.command_error("bounded JSON arguments required");
        };
        let (replay, action) = JournalCommand::decode(raw.as_bytes()).resolve();
        self.replay = replay;
        match action {
            Ok(JournalAction::Help(topic)) => self.help(&topic, read_only),
            Ok(JournalAction::Dispatch(dispatch)) => {
                self.state.calls += 1;
                Outcome::Dispatch {
                    dispatch: Dispatch::Parsed(dispatch),
                }
            }
            Err(error) => self.command_error(&error),
        }
    }

    fn help(&mut self, topic: &str, read_only: bool) -> Outcome {
        if self.state.help_shown {
            self.state.calls += 1;
        }
        self.state.help_shown = true;
        match help::text(topic, read_only) {
            Ok(text) => Outcome::Reply {
                reply: json!({"status": "ok", "help": text}),
            },
            Err(error) => self.command_error(&error),
        }
    }

    fn command_error(&mut self, error: &str) -> Outcome {
        self.state.calls += 1;
        refused(&format!("{error}; run: help"))
    }
}

fn refused(reason: &str) -> Outcome {
    Outcome::Reply {
        reply: json!({"status": "refused", "reason": reason}),
    }
}

#[derive(Serialize)]
pub(super) struct Merged {
    pub(super) text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) status: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) context_note: Option<&'static str>,
}

pub(super) fn merge(
    mut recall: String,
    existing: String,
    context: &str,
    max_chars: usize,
) -> io::Result<Merged> {
    const HEADER: &str = "\nOther historical room evidence:\n";
    const OMITTED: &str = "\nAutomatic journal capsule omitted to preserve the configured context budget; explicit lookup remains available.";
    const PARTIAL: &str = "\nOther retrieved evidence omitted to fit the configured context budget; coverage is incomplete.";
    let existing_chars = existing.chars().count();
    if existing_chars > max_chars {
        return Err(crate::refused());
    }
    let recall_chars = recall.chars().count();
    let (text, status, context_note) = if recall.is_empty() {
        (existing, None, None)
    } else if recall_chars > max_chars {
        let note = (context.chars().count() + OMITTED.len() <= CONTEXT_CHARS).then_some(OMITTED);
        (existing, Some("omitted_due_to_budget"), note)
    } else if existing.is_empty() || recall_chars + HEADER.len() + existing_chars <= max_chars {
        if !existing.is_empty() {
            recall.push_str(HEADER);
            recall.push_str(&existing);
        }
        (recall, Some("included"), None)
    } else {
        if recall_chars + PARTIAL.len() <= max_chars {
            recall.push_str(PARTIAL);
        }
        (recall, Some("included_other_evidence_omitted"), None)
    };
    Ok(Merged {
        text,
        status,
        context_note,
    })
}

#[cfg(test)]
mod tests;
