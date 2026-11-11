use super::*;
use reverie_core::worker_wire::{HEADER_BYTES, MAX_FRAME, WorkerFrameHeader};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
};

pub(super) fn initial(stream: &mut UnixStream, end: Instant) -> Result<(u8, Vec<u8>)> {
    let mut header = [0; HEADER_BYTES];
    read_until(stream, &mut header, end)?;
    let header = WorkerFrameHeader::decode(header);
    let size = header.payload_length() as usize;
    if size > MAX_FRAME {
        return Err(ViewerError::refused("WORKER_VIEWER_FRAME_LIMIT"));
    }
    let mut raw = vec![0; size];
    read_until(stream, &mut raw, end)?;
    Ok((header.kind(), raw))
}
fn read_until(stream: &mut UnixStream, mut bytes: &mut [u8], end: Instant) -> Result<()> {
    while !bytes.is_empty() {
        let left = end
            .checked_duration_since(Instant::now())
            .ok_or_else(|| ViewerError::refused("WORKER_VIEWER_FRAME_DEADLINE"))?;
        stream.set_read_timeout(Some(left))?;
        match stream.read(bytes) {
            Ok(0) => return Err(ViewerError::refused("WORKER_VIEWER_PEER_CLOSED")),
            Ok(count) => bytes = &mut bytes[count..],
            Err(cause) if cause.kind() == std::io::ErrorKind::Interrupted => {}
            Err(cause) => return Err(cause.into()),
        }
    }
    Ok(())
}
pub(super) fn send(stream: &mut UnixStream, kind: u8, bytes: &[u8]) -> Result<()> {
    let header = WorkerFrameHeader::for_payload(kind, bytes.len())
        .ok_or_else(|| ViewerError::refused("WORKER_VIEWER_FRAME_LIMIT"))?;
    let mut raw = Vec::with_capacity(HEADER_BYTES + bytes.len());
    raw.extend_from_slice(&header.encode());
    raw.extend_from_slice(bytes);
    let mut bytes = raw.as_slice();
    let end = Instant::now() + Duration::from_secs(2);
    while !bytes.is_empty() {
        if Instant::now() >= end {
            return Err(ViewerError::refused("WORKER_VIEWER_OUTPUT_DEADLINE"));
        }
        match stream.write(bytes) {
            Ok(0) => return Err(ViewerError::refused("WORKER_VIEWER_PEER_CLOSED")),
            Ok(count) => bytes = &bytes[count..],
            Err(cause)
                if matches!(
                    cause.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                std::thread::sleep(Duration::from_millis(1))
            }
            Err(cause) => return Err(cause.into()),
        }
    }
    Ok(())
}
pub(super) struct Input {
    bytes: Vec<u8>,
    end: Option<Instant>,
}
impl Input {
    pub(super) fn new() -> Self {
        Self {
            bytes: Vec::new(),
            end: None,
        }
    }
    pub(super) fn next(&mut self, stream: &mut UnixStream) -> Result<Option<(u8, Vec<u8>)>> {
        if self.end.is_some_and(|end| Instant::now() >= end) {
            return Err(ViewerError::refused("WORKER_VIEWER_FRAME_DEADLINE"));
        }
        let target = if self.bytes.len() < HEADER_BYTES {
            HEADER_BYTES
        } else {
            let header = WorkerFrameHeader::decode(
                self.bytes[..HEADER_BYTES]
                    .try_into()
                    .expect("checked header"),
            );
            let size = header.payload_length() as usize;
            if size > MAX_FRAME {
                return Err(ViewerError::refused("WORKER_VIEWER_FRAME_LIMIT"));
            }
            HEADER_BYTES + size
        };
        if self.bytes.len() == target && self.bytes.len() >= HEADER_BYTES {
            let kind = self.bytes[0];
            let raw = self.bytes.split_off(HEADER_BYTES);
            self.bytes.clear();
            self.end = None;
            return Ok(Some((kind, raw)));
        }
        let mut raw = vec![0; (target - self.bytes.len()).min(65_536)];
        match stream.read(&mut raw) {
            Ok(0) => Err(ViewerError::refused("WORKER_VIEWER_PEER_CLOSED")),
            Ok(count) => {
                self.end
                    .get_or_insert_with(|| Instant::now() + Duration::from_secs(10));
                self.bytes.extend_from_slice(&raw[..count]);
                Ok(None)
            }
            Err(cause)
                if matches!(
                    cause.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                Ok(None)
            }
            Err(cause) => Err(cause.into()),
        }
    }
}
