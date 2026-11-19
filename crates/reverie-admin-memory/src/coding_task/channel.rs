use super::Controller;
use crate::worker_channel::{WorkerChannel, remaining};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    io,
    num::NonZeroU64,
    time::{Duration, Instant},
};

pub(super) struct Channel {
    stream: WorkerChannel,
    epoch: Option<NonZeroU64>,
    sequence: u64,
    until: Option<Instant>,
}

impl Channel {
    pub(super) fn open() -> io::Result<Self> {
        Ok(Self {
            stream: WorkerChannel::open()?,
            epoch: None,
            sequence: 0,
            until: None,
        })
    }

    pub(super) fn start(&mut self, epoch: NonZeroU64, budget: Duration) -> io::Result<()> {
        self.until = Some(
            Instant::now()
                .checked_add(budget)
                .ok_or_else(crate::refused)?,
        );
        self.epoch = Some(epoch);
        Ok(())
    }

    pub(super) fn receive<T: DeserializeOwned>(&mut self) -> io::Result<T> {
        self.stream
            .read(self.until)?
            .ok_or_else(|| io::ErrorKind::UnexpectedEof.into())
    }

    fn send(&mut self, value: &Value) -> io::Result<()> {
        self.stream.write(value, self.until)
    }

    pub(super) fn finish(&mut self, value: &Value) -> io::Result<()> {
        // A controller that is still listening may receive the stopped outcome
        // at the deadline. Reporting cannot extend the task's effect authority.
        self.until = Instant::now().checked_add(Duration::from_millis(100));
        self.send(value)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    epoch: NonZeroU64,
    sequence: u64,
    ok: bool,
    result: Value,
}

impl Controller for Channel {
    fn remaining(&self) -> Option<Duration> {
        self.until.and_then(remaining)
    }

    fn ask(&mut self, kind: &str, payload: Value) -> io::Result<Value> {
        let epoch = self.epoch.ok_or_else(crate::refused)?;
        self.sequence = self.sequence.checked_add(1).ok_or_else(crate::refused)?;
        self.send(
            &json!({"epoch": epoch, "sequence": self.sequence, "kind": kind, "payload": payload}),
        )?;
        let reply: Reply = self.receive()?;
        if reply.epoch != epoch || reply.sequence != self.sequence || !reply.ok {
            return Err(crate::refused());
        }
        Ok(reply.result)
    }
}
