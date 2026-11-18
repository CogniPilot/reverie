//! Hands loads laptop attachments through the membership-checked Office CLI.
mod scratch;
#[cfg(test)]
mod tests;

use crate::capture::{self, Signals};
use nix::sys::{prctl, signal::Signal};
use reverie_core::ids::{ChatImageFileId, ChatRoomId, ProfileSessionId};
use serde::Deserialize;
use std::{
    env,
    io::{self, Write},
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

const REQUEST_BYTES: usize = 131_072;
const IMAGE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    cli: Vec<String>,
    session: String,
    room: String,
    attachment: String,
    max_bytes: u64,
    timeout: f64,
}

struct Download {
    cli: Vec<String>,
    room: ChatRoomId,
    attachment: ChatImageFileId,
    max_bytes: u64,
    timeout: Duration,
}

fn refused() -> io::Error {
    io::Error::other("scoped image download refused")
}

impl Request {
    fn authorize(self, worker: Option<&str>, session: Option<&str>) -> io::Result<Download> {
        let caller = ProfileSessionId::parse(&self.session).map_err(|_| refused())?;
        if worker != Some("1") || session != Some(caller.as_str()) {
            return Err(refused());
        }
        if self.cli.is_empty()
            || self
                .cli
                .iter()
                .any(|part| part.is_empty() || part.contains('\0'))
            || !(1..=IMAGE_BYTES).contains(&self.max_bytes)
            || !self.timeout.is_finite()
            || self.timeout <= 0.0
            || self.timeout > 120.0
        {
            return Err(refused());
        }
        Ok(Download {
            cli: self.cli,
            room: ChatRoomId::parse(&self.room).map_err(|_| refused())?,
            attachment: ChatImageFileId::parse(&self.attachment).map_err(|_| refused())?,
            max_bytes: self.max_bytes,
            timeout: Duration::from_secs_f64(self.timeout.min(10.0)),
        })
    }
}

impl Download {
    fn fetch(&self, root: &Path, signals: &Signals) -> io::Result<Vec<u8>> {
        let scratch = scratch::ImageScratch::new(root)?;
        let mut command = Command::new(&self.cli[0]);
        command.args(&self.cli[1..]).current_dir(scratch.cwd());
        command.args([
            "fetch",
            self.room.as_str(),
            self.attachment.as_str(),
            "--output",
            scratch::BASENAME,
            "--max-bytes",
            &self.max_bytes.to_string(),
            "--timeout",
            &self.timeout.as_millis().max(1).to_string(),
            "--json",
        ]);
        if !capture::quiet_group(command, Instant::now() + self.timeout, signals)? {
            return Err(refused());
        }
        let bytes = scratch.read(self.max_bytes)?;
        scratch.clean()?;
        Ok(bytes)
    }
}

pub(crate) fn run(expected_parent: i32) -> io::Result<()> {
    crate::check_worker_parent(expected_parent)?;
    let signals = Signals::install()?;
    // Settle the Office process group and scratch directory on ordinary parent
    // loss. The signal is consumed by the same observer as an explicit stop.
    prctl::set_pdeathsig(Signal::SIGTERM)?;
    crate::check_worker_parent(expected_parent)?;
    let request: Request = serde_json::from_slice(&crate::bounded_input(REQUEST_BYTES)?)?;
    let worker = env::var("REVERIE_WORKER").ok();
    let session = env::var("REVERIE_SESSION_ID").ok();
    let download = request.authorize(worker.as_deref(), session.as_deref())?;
    io::stdout()
        .lock()
        .write_all(&download.fetch(Path::new("/scratch/tmp"), &signals)?)
}
