use super::{Controller, FRAME_BYTES};
use nix::unistd::dup;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, BufReader, Write},
    num::NonZeroU64,
    os::{fd::AsFd, unix::net::UnixStream},
    time::{Duration, Instant},
};

pub(super) struct Channel {
    stream: BufReader<UnixStream>,
    epoch: Option<NonZeroU64>,
    sequence: u64,
    until: Option<Instant>,
}

impl Channel {
    pub(super) fn open() -> io::Result<Self> {
        let socket = UnixStream::from(dup(io::stdin().as_fd())?);
        // The worker needs the private full-duplex socket supplied by its parent.
        socket.peer_addr()?;
        Ok(Self {
            stream: BufReader::new(socket),
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

    fn timeout(&self) -> io::Result<Option<Duration>> {
        match self.until {
            Some(_) => self.remaining().map(Some).ok_or_else(timed_out),
            None => Ok(None),
        }
    }

    pub(super) fn receive<T: DeserializeOwned>(&mut self) -> io::Result<T> {
        let mut frame = Vec::new();
        loop {
            self.stream.get_ref().set_read_timeout(self.timeout()?)?;
            let data = self.stream.fill_buf()?;
            if data.is_empty() {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            let boundary = data.iter().position(|&byte| byte == b'\n');
            let end = boundary.unwrap_or(data.len());
            if end > FRAME_BYTES.saturating_sub(frame.len()) {
                return Err(crate::refused());
            }
            frame.extend_from_slice(&data[..end]);
            self.stream.consume(end + usize::from(boundary.is_some()));
            if boundary.is_some() {
                self.timeout()?;
                return serde_json::from_slice(&frame).map_err(Into::into);
            }
        }
    }

    fn send(&mut self, value: &Value) -> io::Result<()> {
        let mut raw = serde_json::to_vec(value)?;
        if raw.len() > FRAME_BYTES {
            return Err(crate::refused());
        }
        raw.push(b'\n');
        let mut bytes = raw.as_slice();
        while !bytes.is_empty() {
            self.stream.get_ref().set_write_timeout(self.timeout()?)?;
            let sent = self.stream.get_mut().write(bytes)?;
            if sent == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            bytes = &bytes[sent..];
        }
        Ok(())
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
        self.until?
            .checked_duration_since(Instant::now())
            .filter(|time| !time.is_zero())
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

fn timed_out() -> io::Error {
    io::ErrorKind::TimedOut.into()
}
