//! Bounded JSON frames on a supervisor-owned Unix socket.
use nix::{
    fcntl::{FcntlArg, FdFlag, fcntl},
    unistd::dup,
};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    io::{self, BufRead, BufReader, Write},
    net::Shutdown,
    os::{fd::AsFd, unix::net::UnixStream},
    time::{Duration, Instant},
};

pub(crate) const FRAME_BYTES: usize = 1_048_576;

pub(crate) struct WorkerChannel(BufReader<UnixStream>, Vec<u8>);

impl WorkerChannel {
    pub(crate) fn open() -> io::Result<Self> {
        Self::from_fd(io::stdin())
    }

    pub(crate) fn from_fd(fd: impl AsFd) -> io::Result<Self> {
        let socket = UnixStream::from(dup(fd)?);
        fcntl(&socket, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC))?;
        socket.peer_addr()?;
        Ok(Self(BufReader::new(socket), Vec::new()))
    }

    pub(crate) fn shutdown(&self) -> io::Result<()> {
        self.0.get_ref().shutdown(Shutdown::Both)
    }

    pub(crate) fn duplicate(&self) -> io::Result<Self> {
        Self::from_fd(self.0.get_ref())
    }

    pub(crate) fn read<T: DeserializeOwned>(
        &mut self,
        deadline: Option<Instant>,
    ) -> io::Result<Option<T>> {
        self.read_bounded(deadline, FRAME_BYTES)
    }

    pub(crate) fn read_bounded<T: DeserializeOwned>(
        &mut self,
        deadline: Option<Instant>,
        limit: usize,
    ) -> io::Result<Option<T>> {
        self.read_frame(deadline, limit, None, true)
    }

    pub(crate) fn read_checked<T: DeserializeOwned>(
        &mut self,
        deadline: Instant,
        limit: usize,
        check: &dyn Fn() -> io::Result<()>,
    ) -> io::Result<Option<T>> {
        self.read_frame(Some(deadline), limit, Some(check), true)
    }

    pub(crate) fn poll(&mut self) -> io::Result<Option<serde_json::Value>> {
        match self.read_frame(
            Some(Instant::now() + Duration::from_millis(1)),
            FRAME_BYTES,
            None,
            false,
        ) {
            Ok(None) => Err(io::ErrorKind::UnexpectedEof.into()),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                Ok(None)
            }
            result => result,
        }
    }

    fn read_frame<T: DeserializeOwned>(
        &mut self,
        deadline: Option<Instant>,
        limit: usize,
        check: Option<&dyn Fn() -> io::Result<()>>,
        strict: bool,
    ) -> io::Result<Option<T>> {
        loop {
            let mut interval = timeout(deadline)?;
            if let Some(check) = check {
                check()?;
                let quantum = Duration::from_millis(50);
                interval = Some(interval.map_or(quantum, |remaining| remaining.min(quantum)));
            }
            self.0.get_ref().set_read_timeout(interval)?;
            let data = match self.0.fill_buf() {
                Err(error)
                    if check.is_some()
                        && matches!(
                            error.kind(),
                            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                        ) =>
                {
                    continue;
                }
                result => result?,
            };
            if data.is_empty() && self.1.is_empty() {
                return Ok(None);
            }
            if data.is_empty() {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            let boundary = data.iter().position(|&byte| byte == b'\n');
            let end = boundary.unwrap_or(data.len());
            if end > limit.saturating_sub(self.1.len()) {
                return Err(crate::refused());
            }
            self.1.extend_from_slice(&data[..end]);
            self.0.consume(end + usize::from(boundary.is_some()));
            if boundary.is_none() {
                continue;
            }
            let frame = std::mem::take(&mut self.1);
            if strict {
                timeout(deadline)?;
            }
            return Ok(Some(serde_json::from_slice(&frame)?));
        }
    }

    pub(crate) fn write(
        &mut self,
        value: &impl Serialize,
        deadline: Option<Instant>,
    ) -> io::Result<()> {
        self.write_bounded(value, deadline, FRAME_BYTES)
    }

    pub(crate) fn write_bounded(
        &mut self,
        value: &impl Serialize,
        deadline: Option<Instant>,
        limit: usize,
    ) -> io::Result<()> {
        let mut raw = serde_json::to_vec(value)?;
        if raw.len() > limit {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polling_keeps_a_partial_frame_for_the_next_pass() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        let mut channel = WorkerChannel::from_fd(reader).unwrap();
        writer.write_all(br#"{"phase":"#).unwrap();
        assert!(channel.poll().unwrap().is_none());
        writeln!(writer, r#""tool"}}"#).unwrap();
        let observed: serde_json::Value = channel.read(None).unwrap().unwrap();
        assert_eq!(observed["phase"], "tool");
    }
}
