//! Recheck the exact source and current Office authority before coding effects.
mod source;

use super::{control, permitted};
use crate::{
    TURN_CAPTURE_BOUND,
    coding_task::check_coding,
    hands_chat::{Client, Operation},
    refused,
    worker_channel::{FRAME_BYTES, WorkerChannel},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    office: Option<Client>,
    request: Request,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    config_path: Option<PathBuf>,
    settings: Value,
    room: String,
    session: String,
    task: String,
    message: Value,
    history_n: usize,
    expired: bool,
    check_cancel: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Denial {
    AuthorizationUnavailable,
    NotMember,
    Revoked,
    Cancelled,
    Silent,
}

type Decision<T = ()> = Result<T, Denial>;

struct Office<'a> {
    client: Option<Client>,
    channel: &'a mut WorkerChannel,
}

impl Office<'_> {
    fn call(&mut self, operation: Operation) -> Decision<Value> {
        if let Some(client) = &self.client {
            return client
                .call(&operation)
                .map_err(|_| Denial::AuthorizationUnavailable);
        }
        self.exchange(operation)
            .map_err(|_| Denial::AuthorizationUnavailable)
    }

    fn exchange(&mut self, operation: Operation) -> io::Result<Value> {
        self.channel.write_bounded(
            &json!({"operation":operation}),
            Some(deadline()),
            TURN_CAPTURE_BOUND,
        )?;
        let mut reply: Value = self
            .channel
            .read_bounded(Some(deadline()), TURN_CAPTURE_BOUND)?
            .ok_or_else(refused)?;
        reply
            .as_object_mut()
            .and_then(|object| object.remove("value"))
            .ok_or_else(refused)
    }
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

pub(crate) fn run(parent: i32) -> io::Result<()> {
    crate::bind_worker(parent)?;
    let mut channel = WorkerChannel::open()?;
    let job: Job = channel.read(Some(deadline()))?.ok_or_else(refused)?;
    let denial = job
        .request
        .authorize(&mut Office {
            client: job.office,
            channel: &mut channel,
        })
        .err();
    channel.write(&json!({"denial":denial}), Some(deadline()))
}

impl Request {
    fn authorize(&self, office: &mut Office<'_>) -> Decision {
        if self.expired && self.check_cancel {
            return Err(Denial::Cancelled);
        }
        self.require_authority(&self.message)?;
        self.require_member(office)?;
        let view = office.call(Operation::MemberAlert {
            room: self.room.clone(),
            session: self.session.clone(),
        })?;
        let lease = source::Lease::read(&view)?;
        if self.check_cancel {
            self.check_history(office)?;
        }
        // Exact content and the latest owner mark must be the last remote read.
        let id = self.message["id"]
            .as_str()
            .ok_or(Denial::AuthorizationUnavailable)?;
        let fresh = office.call(Operation::Exact {
            room: self.room.clone(),
            id: id.to_owned(),
        })?;
        if !source::matches(&self.message, &fresh, &self.room)? {
            return Err(Denial::Revoked);
        }
        self.require_authority(&fresh)?;
        lease.allows(&fresh)
    }

    fn require_authority(&self, message: &Value) -> Decision {
        let current = match &self.config_path {
            Some(path) => current_settings(path).map_err(|_| Denial::AuthorizationUnavailable)?,
            None => self.settings.clone(),
        };
        check_coding(&current).map_err(|_| Denial::AuthorizationUnavailable)?;
        if source::equivalent(&current, &self.settings) && self.permitted(message) {
            Ok(())
        } else {
            Err(Denial::Revoked)
        }
    }

    fn permitted(&self, message: &Value) -> bool {
        let task = &self.settings["tasks"][&self.task];
        permitted(
            &self.room,
            &task["rooms"],
            &task["delegate_sessions"],
            &message["from"],
        )
    }

    fn require_member(&self, office: &mut Office<'_>) -> Decision {
        let members = office.call(Operation::Rooms)?;
        if members
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| row["id"] == self.room))
        {
            Ok(())
        } else {
            Err(Denial::NotMember)
        }
    }

    fn check_history(&self, office: &mut Office<'_>) -> Decision {
        let history = office.call(Operation::History {
            room: self.room.clone(),
            count: self.history_n.to_string(),
        })?;
        let messages = history["messages"]
            .as_array()
            .ok_or(Denial::AuthorizationUnavailable)?;
        for candidate in messages {
            if self.cancels(candidate)? {
                return Err(Denial::Cancelled);
            }
        }
        Ok(())
    }

    fn cancels(&self, candidate: &Value) -> Decision<bool> {
        if candidate["phoneWake"] == false
            || source::timestamp(candidate)? <= source::timestamp(&self.message)?
        {
            return Ok(false);
        }
        let instruction = candidate["text"]
            .as_str()
            .and_then(|text| control(text, candidate["from"]["kind"] == "agent"));
        Ok(instruction.is_some_and(|instruction| {
            instruction.action == "cancel" && instruction.task_id == self.task
        }) && self.permitted(candidate))
    }
}

fn current_settings(path: &Path) -> io::Result<Value> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take((FRAME_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > FRAME_BYTES {
        return Err(refused());
    }
    let mut parsed: Value = serde_json::from_slice(&bytes)?;
    let object = parsed.as_object_mut().ok_or_else(refused)?;
    Ok(object.remove("coding").unwrap_or_default())
}

pub(super) fn legacy_alert(view: &Value, message: &Value) -> Value {
    let decision = source::Lease::read(view).and_then(|lease| lease.allows_notification(message));
    match decision {
        Ok(()) => json!({"allowed":true}),
        Err(Denial::Silent) => json!({"allowed":false}),
        Err(_) => json!({"error":"room view has an invalid alert lease"}),
    }
}
