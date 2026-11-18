//! Hands loads laptop attachments through the membership-checked Office CLI.
mod scratch;
#[cfg(test)]
pub(crate) mod tests;

use crate::capture::{self, Signals};
use nix::sys::{prctl, signal::Signal};
use reverie_core::ids::{ChatImageFileId, ChatRoomId, ProfileSessionId};
use std::{
    io,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

const IMAGE_BYTES: u64 = 64 * 1024 * 1024;

pub(super) struct Request {
    pub(super) cli: Vec<String>,
    pub(super) session: String,
    pub(super) room: String,
    pub(super) attachment: String,
    pub(super) max_bytes: u64,
    pub(super) timeout: f64,
}

pub(super) struct Download {
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
    pub(super) fn authorize(
        self,
        worker: Option<&str>,
        session: Option<&str>,
    ) -> io::Result<Download> {
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
    pub(super) fn fetch(&self, root: &Path, signals: &Signals) -> io::Result<Vec<u8>> {
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

pub(super) fn bind_download_worker(expected_parent: i32) -> io::Result<Signals> {
    crate::check_worker_parent(expected_parent)?;
    let signals = Signals::install()?;
    // Settle the Office process group and scratch directory on ordinary parent
    // loss. The signal is consumed by the same observer as an explicit stop.
    prctl::set_pdeathsig(Signal::SIGTERM)?;
    crate::check_worker_parent(expected_parent)?;
    Ok(signals)
}
