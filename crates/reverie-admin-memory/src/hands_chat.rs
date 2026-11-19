//! Bounded Hands client for the existing scoped Office chat CLI.
use crate::{capture, office, refused, worker_channel::FRAME_BYTES};
use reverie_core::{python_lowercase_string, python_trim_text};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env,
    io::{self, ErrorKind},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    cli: Vec<String>,
    timeout_s: f64,
    operation: Operation,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Client {
    cli: Vec<String>,
    timeout_s: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Operation {
    History {
        room: String,
        count: String,
    },
    Exact {
        room: String,
        id: String,
    },
    MemberAlert {
        room: String,
        session: String,
    },
    Summary,
    Say {
        room: String,
        text: String,
        reply_to: Option<String>,
    },
    Rooms,
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let request: Request = serde_json::from_slice(&crate::worker_input(parent, FRAME_BYTES)?)?;
    let client = Client {
        cli: request.cli,
        timeout_s: request.timeout_s,
    };
    let result = match client.call(&request.operation) {
        Ok(value) => json!({"status": "ok", "value": value}),
        Err(Error::NotFound) => json!({"status": "not_found"}),
        Err(Error::Timeout) => json!({"status": "timeout"}),
        Err(Error::Invalid(reason)) => json!({"status": "invalid", "reason": reason}),
        Err(Error::Unavailable) => json!({"status": "unavailable"}),
    };
    crate::write_reply(&result, office::HISTORY_BYTES + 1024)
}

pub(super) fn summary(cli: Vec<String>, timeout_s: f64) -> Option<String> {
    Client { cli, timeout_s }
        .call(&Operation::Summary)
        .ok()?
        .as_str()
        .map(str::to_owned)
}

pub(super) enum Error {
    NotFound,
    Timeout,
    Invalid(&'static str),
    Unavailable,
}

impl Client {
    pub(super) fn call(&self, operation: &Operation) -> Result<Value, Error> {
        let deadline = Duration::try_from_secs_f64(self.timeout_s)
            .ok()
            .filter(|timeout| !timeout.is_zero())
            .and_then(|timeout| Instant::now().checked_add(timeout))
            .ok_or(Error::Unavailable)?;
        let mut command = guarded_command(&self.cli).map_err(|_| Error::Unavailable)?;
        command.args(operation.args());
        let result = capture::completed(
            command,
            None,
            capture::Limits::scoped(deadline, operation.byte_cap()),
        )
        .map_err(|error| {
            if error.kind() == ErrorKind::TimedOut {
                Error::Timeout
            } else {
                Error::Unavailable
            }
        })?;
        if !result.success {
            return Err(if office::not_found(&result.stdout) {
                Error::NotFound
            } else {
                Error::Unavailable
            });
        }
        operation.decode(&result.stdout)
    }
}

fn guarded_command(cli: &[String]) -> io::Result<Command> {
    let (program, prefix) = cli
        .split_first()
        .filter(|(program, _)| !program.is_empty())
        .ok_or_else(refused)?;
    let executable = resolve(Path::new(program)).ok_or_else(refused)?;
    let mut command = Command::new(env::current_exe()?);
    command
        .arg(format!("--hands-guard={}", std::process::id()))
        .arg(executable)
        .args(prefix);
    Ok(command)
}

fn resolve(program: &Path) -> Option<PathBuf> {
    if program.as_os_str().as_encoded_bytes().contains(&b'/') {
        return std::path::absolute(program).ok();
    }
    let search = env::var_os("PATH").unwrap_or_else(|| "/bin:/usr/bin".into());
    env::split_paths(&search).find_map(|root| {
        let path = root.join(program);
        if path.is_file() && nix::unistd::access(&path, nix::unistd::AccessFlags::X_OK).is_ok() {
            std::path::absolute(path).ok()
        } else {
            None
        }
    })
}

impl Operation {
    fn args(&self) -> Vec<&str> {
        match self {
            Self::History { room, count } => office::read_args(room, ["-n", count]).into(),
            Self::Exact { room, id } => office::read_args(room, ["--message", id]).into(),
            Self::MemberAlert { room, .. } => office::read_args(room, ["-n", "1"]).into(),
            Self::Summary => vec!["summary", "--json"],
            Self::Say {
                room,
                text,
                reply_to,
            } => {
                let mut args = vec!["say", "--room", room, "--json"];
                if let Some(id) = reply_to {
                    args.extend(["--reply-to", id]);
                }
                args.extend(["--", text]);
                args
            }
            Self::Rooms => vec!["rooms", "--json"],
        }
    }

    fn byte_cap(&self) -> usize {
        match self {
            Self::History { .. } | Self::Exact { .. } | Self::MemberAlert { .. } => {
                office::HISTORY_BYTES
            }
            _ => office::ROOM_LIST_BYTES,
        }
    }

    fn decode(&self, output: &[u8]) -> Result<Value, Error> {
        let decoded = serde_json::from_slice::<Value>(output);
        if matches!(self, Self::Say { .. }) {
            // Receipt-less success leaves the original POST outcome unconfirmed.
            return Ok(decoded
                .ok()
                .and_then(|mut reply| reply.as_object_mut()?.remove("message"))
                .unwrap_or(Value::Null));
        }
        let mut reply = decoded.map_err(|_| Error::Invalid("invalid chat JSON"))?;
        match self {
            Self::History { .. } => history(reply),
            Self::Exact { room, id } => exact(reply, room, id),
            Self::MemberAlert { session, .. } => alert(&reply, session),
            Self::Summary => reply
                .get("text")
                .filter(|text| text.is_string())
                .cloned()
                .ok_or(Error::Invalid("Invalid turn summary")),
            Self::Rooms => {
                let rooms = reply
                    .as_array_mut()
                    .ok_or(Error::Invalid("rooms --json is not a list"))?;
                rooms.retain(Value::is_object);
                Ok(reply)
            }
            Self::Say { .. } => unreachable!("say receipts handled above"),
        }
    }
}

fn history(mut reply: Value) -> Result<Value, Error> {
    let data = reply
        .as_object_mut()
        .ok_or(Error::Invalid("invalid room history"))?;
    let mut messages = match data.remove("messages") {
        None => Vec::new(),
        Some(Value::Array(messages)) => messages,
        _ => return Err(Error::Invalid("invalid room history")),
    };
    messages.retain(|message| message.get("id").is_some_and(crate::hands_settings::truthy));
    if messages
        .iter()
        .any(|message| !message["phoneWake"].is_boolean())
    {
        return Err(Error::Invalid(
            "Server did not verify current phone delivery; no automatic replies",
        ));
    }
    let zone = data
        .remove("timeZone")
        .and_then(crate::hands_prompt::reported_zone);
    Ok(json!({"messages": messages, "timeZone": zone}))
}

fn exact(mut reply: Value, room: &str, id: &str) -> Result<Value, Error> {
    let message = reply
        .as_object_mut()
        .ok_or(Error::Invalid("No exact current phone acceptance"))?
        .remove("message")
        .filter(|message| !message.is_null())
        .ok_or(Error::NotFound)?;
    if message["id"].as_str() == Some(id)
        && message["roomId"].as_str() == Some(room)
        && message["phoneWake"].is_boolean()
    {
        Ok(message)
    } else {
        Err(Error::Invalid("No exact current phone acceptance"))
    }
}

fn alert(reply: &Value, session: &str) -> Result<Value, Error> {
    let members = reply["members"]
        .as_array()
        .ok_or(Error::Invalid("room view has no members"))?;
    let mut selected = members
        .iter()
        .filter(|member| member["sessionId"].as_str() == Some(session));
    let first = selected
        .next()
        .filter(|_| selected.next().is_none())
        .ok_or(Error::Invalid("room view has no unique current session"))?;
    let unique = first["name"]
        .as_str()
        .filter(|name| !python_trim_text(name).is_empty())
        .is_some_and(|name| {
            let name = python_lowercase_string(name);
            members
                .iter()
                .filter_map(|member| member["name"].as_str())
                .filter(|other| python_lowercase_string(other) == name)
                .take(2)
                .count()
                == 1
        });
    Ok(json!({"lease": first["alertMode"], "name": first["name"], "unique": unique}))
}
