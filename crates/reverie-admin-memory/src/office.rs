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

const ROOM_LIST_BYTES: usize = 1_048_576;
const HISTORY_BYTES: usize = 8_388_608;

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
            &[
                "read",
                "--room",
                room.as_str(),
                "-n",
                &count.to_string(),
                "--json",
            ],
            HISTORY_BYTES,
        )
    }

    pub(crate) fn exact_message(
        &self,
        room: &ChatRoomId,
        id: &ChatMessageId,
    ) -> io::Result<Vec<u8>> {
        self.run(
            &[
                "read",
                "--room",
                room.as_str(),
                "--message",
                id.as_str(),
                "--json",
            ],
            HISTORY_BYTES,
        )
    }

    fn run(&self, args: &[&str], max_bytes: usize) -> io::Result<Vec<u8>> {
        let mut command = Command::new(&self.cli[0]);
        command.args(&self.cli[1..]).args(args);
        let deadline = Instant::now() + Duration::from_secs_f64(self.memory_timeout_s.min(10.0));
        capture::run(command, None, Limits::office(deadline, max_bytes))
    }
}
