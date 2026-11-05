use crate::{Error, Result, native};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, IntoRawFd};
use std::os::unix::net::UnixStream;
use std::time::Instant;

pub(crate) const MAX_FRAME: usize = 262_144;
pub(crate) struct Frame {
    pub(crate) kind: u8,
    pub(crate) payload: Vec<u8>,
}
pub(crate) struct Connection {
    stream: UnixStream,
    endpoint: native::Endpoint,
    deadline: Option<Instant>,
}
impl Connection {
    pub(crate) fn open(deadline: Option<Instant>) -> Result<Self> {
        let path = std::env::var_os("REVERIE_WORKER_SOCKET")
            .ok_or(Error("Worker execution is not configured"))?;
        Self::at(std::path::Path::new(&path), deadline)
    }
    fn at(path: &std::path::Path, deadline: Option<Instant>) -> Result<Self> {
        let endpoint = native::Endpoint::open(path)?;
        let stream = native::connect(endpoint.path(), deadline)?;
        endpoint.check(&stream)?;
        Ok(Self {
            stream,
            endpoint,
            deadline,
        })
    }
    pub(crate) fn fd(&self) -> i32 {
        self.stream.as_raw_fd()
    }
    pub(crate) fn validate(&self) -> Result<()> {
        self.check_deadline()?;
        self.endpoint.check(&self.stream)
    }
    fn check_deadline(&self) -> Result<()> {
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            Err(Error("Private worker deadline exceeded"))
        } else {
            Ok(())
        }
    }
    pub(crate) fn send(&mut self, kind: u8, bytes: &[u8]) -> Result<()> {
        if bytes.len() > MAX_FRAME {
            return Err(Error("Worker frame is too large"));
        }
        let mut wire = Vec::with_capacity(bytes.len() + 5);
        wire.push(kind);
        wire.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        wire.extend_from_slice(bytes);
        let mut remaining = wire.as_slice();
        while !remaining.is_empty() {
            self.check_deadline()?;
            native::wait(self.fd(), libc::POLLOUT, self.deadline)?;
            match self.stream.write(remaining) {
                Ok(0) => return Err(Error("Worker connection closed")),
                Ok(written) => remaining = &remaining[written..],
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
    pub(crate) fn receive(&mut self, limit: usize) -> Result<Frame> {
        let mut decoder = Decoder::new(limit);
        loop {
            self.check_deadline()?;
            if let Some(frame) = decoder.next(self)? {
                return Ok(frame);
            }
            native::wait(self.fd(), libc::POLLIN, self.deadline)?;
        }
    }
    pub(crate) fn finish<T>(self, result: Result<T>) -> Result<T> {
        let stream = native::close(self.stream.into_raw_fd());
        let endpoint = self.endpoint.close();
        if stream.is_err() || endpoint.is_err() {
            return Err(Error("Worker connection closure unconfirmed"));
        }
        result
    }
}
pub(crate) struct Decoder {
    bytes: Vec<u8>,
    target: usize,
    limit: usize,
}

impl Decoder {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            target: 5,
            limit,
        }
    }
    pub(crate) fn next(&mut self, connection: &mut Connection) -> Result<Option<Frame>> {
        loop {
            connection.check_deadline()?;
            if let Some(frame) = self.completed()? {
                return Ok(Some(frame));
            }
            let mut buffer = [0_u8; 65_536];
            let wanted = (self.target - self.bytes.len()).min(buffer.len());
            match connection.stream.read(&mut buffer[..wanted]) {
                Ok(0) => return Err(Error("Worker connection closed")),
                Ok(count) => self.bytes.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(None),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    fn completed(&mut self) -> Result<Option<Frame>> {
        if self.bytes.len() != self.target {
            return Ok(None);
        }
        if self.target == 5 {
            let size =
                u32::from_be_bytes(self.bytes[1..5].try_into().expect("fixed header")) as usize;
            if size > self.limit {
                return Err(Error("Worker frame is too large"));
            }
            self.target = 5 + size;
            if size != 0 {
                return Ok(None);
            }
        }
        let bytes = std::mem::take(&mut self.bytes);
        self.target = 5;
        Ok(Some(Frame {
            kind: bytes[0],
            payload: bytes[5..].to_vec(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::Connection;
    use crate::{Error, native, test_support::Socket};
    #[test]
    fn checked_socket_close_never_turns_refusal_or_success_into_acknowledgement() {
        for successful in [true, false] {
            let socket = Socket::new();
            let connection = Connection::at(&socket.path, None).unwrap();
            let result = if successful {
                Ok(0)
            } else {
                Err(Error("fixture refusal"))
            };
            assert!(native::with_close_failure(|| connection.finish(result)).is_err());
        }
    }
}
