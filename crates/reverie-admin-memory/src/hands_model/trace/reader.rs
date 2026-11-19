use super::{
    DisplayKind,
    file::{EVENT_CHARS, TracePath},
    redact,
};
use crate::worker_channel::WorkerChannel;
use nix::{
    errno::Errno,
    fcntl::{Flock, FlockArg},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const POLL_BYTES: usize = 262_144;
const GENERATION_BYTES: u64 = 512;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Startup {
    path: PathBuf,
    from_end: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Message {
    Poll,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct Event {
    pub(crate) kind: DisplayKind,
    pub(crate) text: String,
}

fn display_line(line: &[u8]) -> Option<Event> {
    let mut event: Event = serde_json::from_slice(line).ok()?;
    if event.text.chars().count() > EVENT_CHARS {
        return None;
    }
    event.text = redact(&event.text);
    Some(event)
}

#[derive(PartialEq, Eq)]
struct Generation {
    device: u64,
    inode: u64,
    header: Vec<u8>,
}

impl Generation {
    fn inspect(file: &mut File) -> io::Result<(Self, u64)> {
        let info = file.metadata()?;
        let mut header = Vec::new();
        BufReader::new(file)
            .take(GENERATION_BYTES)
            .read_until(b'\n', &mut header)?;
        Ok((
            Self {
                device: info.dev(),
                inode: info.ino(),
                header,
            },
            info.len(),
        ))
    }

    fn matches(&self, previous: &Self) -> bool {
        self.device == previous.device
            && self.inode == previous.inode
            && (self.header == previous.header ||
                // The first record of a legacy file can still be in flight.
                previous.header.len() < GENERATION_BYTES as usize
                    && !previous.header.ends_with(b"\n")
                    && self.header.starts_with(&previous.header))
    }
}

pub(crate) struct Reader {
    path: TracePath,
    generation: Option<Generation>,
    offset: u64,
    discard_line: bool,
}

impl Reader {
    pub(crate) fn new(path: &Path, from_end: bool) -> io::Result<Self> {
        let path = TracePath::new(path)?;
        let mut reader = Self {
            path,
            generation: None,
            offset: 0,
            discard_line: false,
        };
        if let Some(mut file) = reader.path.read()? {
            let (generation, size) = Generation::inspect(&mut file)?;
            reader.generation = Some(generation);
            if from_end && size != 0 {
                reader.offset = size;
                file.seek(SeekFrom::Start(size - 1))?;
                let mut tail = [0];
                let read = file.read(&mut tail)?;
                // A pre-existing partial record is part of the old transcript.
                reader.discard_line = read != 0 && tail != [b'\n'];
            }
        }
        Ok(reader)
    }

    pub(crate) fn poll(&mut self) -> io::Result<Vec<Event>> {
        let Some(file) = self.path.read()? else {
            return Ok(Vec::new());
        };
        let mut locked = match Flock::lock(file, FlockArg::LockSharedNonblock) {
            Ok(locked) => locked,
            Err((_, Errno::EWOULDBLOCK)) => return Ok(Vec::new()),
            Err((_, error)) => return Err(error.into()),
        };
        let (generation, size) = Generation::inspect(&mut locked)?;
        if size < self.offset
            || self
                .generation
                .as_ref()
                .is_none_or(|old| !generation.matches(old))
        {
            self.offset = 0;
            self.discard_line = false;
        }
        self.generation = Some(generation);
        locked.seek(SeekFrom::Start(self.offset))?;
        let mut raw = Vec::new();
        (&mut *locked)
            .take(POLL_BYTES as u64)
            .read_to_end(&mut raw)?;
        Ok(self.consume(&raw))
    }

    fn consume(&mut self, raw: &[u8]) -> Vec<Event> {
        let Some(last) = raw.iter().rposition(|&byte| byte == b'\n') else {
            if raw.len() == POLL_BYTES {
                // A single line this long cannot be a valid display event.
                self.offset += raw.len() as u64;
                self.discard_line = true;
            }
            return Vec::new();
        };
        let mut lines = raw[..=last].split(|&byte| byte == b'\n');
        if self.discard_line {
            lines.next();
            self.discard_line = false;
        }
        self.offset += (last + 1) as u64;
        lines.filter_map(display_line).collect()
    }
}

pub(crate) fn trace_worker(parent: i32) -> io::Result<()> {
    crate::bind_worker(parent)?;
    let mut channel = WorkerChannel::open()?;
    let startup: Startup = channel.read(None)?.ok_or_else(crate::refused)?;
    let mut reader = Reader::new(&startup.path, startup.from_end)?;
    channel.write(&json!({"ready": true}), Some(response_deadline()))?;
    while let Some(Message::Poll) = channel.read(None)? {
        channel.write(&reader.poll()?, Some(response_deadline()))?;
    }
    Ok(())
}

fn response_deadline() -> Instant {
    Instant::now() + Duration::from_millis(500)
}

#[cfg(test)]
mod tests;
