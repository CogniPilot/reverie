//! Bounded JSON frames on a supervisor-owned Unix socket.
use nix::unistd::dup;
use serde::{Serialize, de::DeserializeOwned};
use std::{
    io::{self, BufRead, BufReader, Write},
    net::Shutdown,
    os::{fd::AsFd, unix::net::UnixStream},
    time::{Duration, Instant},
};

pub(crate) const FRAME_BYTES: usize = 1_048_576;

pub(crate) struct WorkerChannel(BufReader<UnixStream>);

impl WorkerChannel {
    pub(crate) fn open() -> io::Result<Self> {
        Self::from_fd(io::stdin())
    }

    pub(crate) fn from_fd(fd: impl AsFd) -> io::Result<Self> {
        let socket = UnixStream::from(dup(fd)?);
        socket.peer_addr()?;
        Ok(Self(BufReader::new(socket)))
    }

    pub(crate) fn shutdown(&self) -> io::Result<()> {
        self.0.get_ref().shutdown(Shutdown::Both)
    }

    pub(crate) fn read<T: DeserializeOwned>(
        &mut self,
        deadline: Option<Instant>,
    ) -> io::Result<Option<T>> {
        let mut frame = Vec::new();
        loop {
            self.0.get_ref().set_read_timeout(timeout(deadline)?)?;
            let data = self.0.fill_buf()?;
            if data.is_empty() && frame.is_empty() {
                return Ok(None);
            }
            if data.is_empty() {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            let boundary = data.iter().position(|&byte| byte == b'\n');
            let end = boundary.unwrap_or(data.len());
            if end > FRAME_BYTES.saturating_sub(frame.len()) {
                return Err(crate::refused());
            }
            frame.extend_from_slice(&data[..end]);
            self.0.consume(end + usize::from(boundary.is_some()));
            if boundary.is_some() {
                timeout(deadline)?;
                return Ok(Some(serde_json::from_slice(&frame)?));
            }
        }
    }

    pub(crate) fn write(
        &mut self,
        value: &impl Serialize,
        deadline: Option<Instant>,
    ) -> io::Result<()> {
        let mut raw = serde_json::to_vec(value)?;
        if raw.len() > FRAME_BYTES {
            return Err(crate::refused());
        }
        raw.push(b'\n');
        let mut bytes = raw.as_slice();
        while !bytes.is_empty() {
            self.0.get_ref().set_write_timeout(timeout(deadline)?)?;
            let sent = self.0.get_mut().write(bytes)?;
            if sent == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            bytes = &bytes[sent..];
        }
        Ok(())
    }
}

pub(crate) fn remaining(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|time| !time.is_zero())
}

fn timeout(deadline: Option<Instant>) -> io::Result<Option<Duration>> {
    deadline
        .map(|deadline| remaining(deadline).ok_or_else(|| io::ErrorKind::TimedOut.into()))
        .transpose()
}
