use crate::{
    capture::{self, Limits},
    refused,
};
use reverie_contracts::memory::channel::Membership;
use reverie_core::ids::{ChatMessageId, ChatRoomId};
use serde::Deserialize;
use std::{
    io,
    process::Command,
    time::{Duration, Instant},
};

pub(super) const ROOM_LIST_BYTES: usize = 1_048_576;
pub(super) const HISTORY_BYTES: usize = 8_388_608;

pub(super) fn read_args<'a>(room: &'a str, [selector, value]: [&'a str; 2]) -> [&'a str; 6] {
    ["read", "--room", room, selector, value, "--json"]
}

#[derive(Deserialize)]
pub(crate) struct Office {
    cli: Vec<String>,
    #[serde(default = "office_timeout")]
    memory_timeout_s: f64,
}

fn office_timeout() -> f64 {
    3.0
}

impl Office {
    pub(crate) fn validate(&self) -> io::Result<()> {
        if self.cli.first().is_none_or(String::is_empty)
            || !self.memory_timeout_s.is_finite()
            || self.memory_timeout_s <= 0.0
        {
            return Err(refused());
        }
        Ok(())
    }

    pub(crate) fn rooms(&self) -> io::Result<Membership> {
        let output = self.run(&["rooms", "--json"], ROOM_LIST_BYTES)?;
        Membership::decode(&output).ok_or_else(refused)
    }

    pub(crate) fn require_membership(&self, room: &ChatRoomId) -> io::Result<()> {
        if self.rooms()?.contains(room) {
            Ok(())
        } else {
            Err(refused())
        }
    }

    pub(crate) fn history(&self, room: &ChatRoomId, count: i64) -> io::Result<Vec<u8>> {
        self.run(
            &read_args(room.as_str(), ["-n", &count.to_string()]),
            HISTORY_BYTES,
        )
    }

    pub(crate) fn exact_message(
        &self,
        room: &ChatRoomId,
        id: &ChatMessageId,
    ) -> io::Result<Option<Vec<u8>>> {
        let command = self.command(&read_args(room.as_str(), ["--message", id.as_str()]));
        let output = capture::completed(command, None, self.limits(HISTORY_BYTES))?;
        if output.success {
            let response: ExactRead<'_> = serde_json::from_slice(&output.stdout)?;
            return Ok(response.message.is_some().then_some(output.stdout));
        }
        if not_found(&output.stdout) {
            Ok(None)
        } else {
            Err(refused())
        }
    }

    fn run(&self, args: &[&str], max_bytes: usize) -> io::Result<Vec<u8>> {
        capture::run(self.command(args), None, self.limits(max_bytes))
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(&self.cli[0]);
        command.args(&self.cli[1..]).args(args);
        command
    }

    fn limits(&self, max_bytes: usize) -> Limits<'_> {
        let deadline = Instant::now() + Duration::from_secs_f64(self.memory_timeout_s.min(10.0));
        Limits::office(deadline, max_bytes)
    }
}

#[derive(Deserialize)]
struct ExactRead<'a> {
    #[serde(borrow)]
    message: Option<&'a serde_json::value::RawValue>,
}

pub(super) fn not_found(stdout: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(stdout).is_ok_and(|reply| {
        reply["success"].as_bool() == Some(false)
            && reply["error"]
                .as_str()
                .is_some_and(|code| code.starts_with("NOT_FOUND"))
    })
}
