//! One-shot birth-metadata publication by the original native bootstrap.
//! Files are immutable input DATA; publication is never controller activation,
//! owner consent, provider fencing, pool enforcement or a capacity receipt.
mod bootstrap;
mod directories;
#[cfg(test)]
mod tests;
mod version;
use super::*;
use crate::{
    captured_client::CancellationToken,
    native,
    worker_runtime::{WorkerRuntime, WorkerStopBudget},
};
use reverie_contracts::worker_pool::{
    ControllerBirthV2, ControllerServiceBirth, RetainedPoolAnchor,
};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{fs::File, time::Instant};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishedControllerBirthData {
    filename: String,
    digest: [u8; 32],
    directory: [u64; 2],
    file: [u64; 2],
}
impl PublishedControllerBirthData {
    pub fn filename(&self) -> &str {
        &self.filename
    }
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }
    pub fn directory_identity(&self) -> [u64; 2] {
        self.directory
    }
    pub fn file_identity(&self) -> [u64; 2] {
        self.file
    }
}

/// Retained before the first directory or file effect. No descriptor/path
/// getter, replacement, replay, cached-existing success or automatic removal.
#[must_use = "retain partial publication through checked metadata finalization"]
pub struct ControllerBirthPublication {
    birth: ControllerServiceBirth,
    source: Option<bootstrap::RegisteredBirthSource>,
    raw: Vec<u8>,
    digest: [u8; 32],
    filename: String,
    directories: directories::Directories,
    writer: Option<File>,
    reader: Option<File>,
    stamp: Option<native::Stamp>,
    cancellation: CancellationToken,
    stop: WorkerStopBudget,
    deadline: Instant,
    attempted: bool,
    published: bool,
    closed: bool,
    close_unknown: bool,
    failed: AtomicBool,
}
impl ControllerBirthPublication {
    /// Only the retained bootstrap wrapper supplies this actual birth record.
    /// Construction is read-only and does not create ~/reverie implicitly.
    fn unopened(
        runtime: &WorkerRuntime,
        birth: ControllerServiceBirth,
        source: bootstrap::RegisteredBirthSource,
        end: Instant,
    ) -> Result<Self> {
        let ids = runtime.worker_identity().ids();
        let identity = birth.identity();
        need(
            identity.broker().ids() == [ids.uid(), ids.gid()]
                && identity.policy().deployment == runtime.worker_identity().deployment()
                && ids.uid() == native::uid()
                && ids.gid() == nix::unistd::getegid().as_raw(),
            "WORKER_POOL_PUBLICATION_SCOPE",
        )?;
        let home = native::python_path(&native::home_directory(None)?)?;
        let root = home.join("reverie");
        need(
            root == std::path::Path::new(&identity.policy().instance_root),
            "WORKER_POOL_PUBLICATION_INSTANCE",
        )?;
        let mut owner = Self::new(runtime, birth, root, end)?;
        owner.source = Some(source);
        Ok(owner)
    }
    fn new(
        runtime: &WorkerRuntime,
        birth: impl Into<ControllerServiceBirth>,
        root: std::path::PathBuf,
        end: Instant,
    ) -> Result<Self> {
        let ids = runtime.worker_identity().ids();
        let birth = birth.into();
        let raw = birth
            .encode()
            .map_err(|_| PoolError::Refused("WORKER_POOL_BIRTH_INVALID"))?;
        let digest: [u8; 32] = Sha256::digest(&raw).into();
        Ok(Self {
            birth,
            source: None,
            raw,
            digest,
            filename: format!("{}.json", super::policy::digest_text(digest)),
            directories: directories::Directories::unopened(root, [ids.uid(), ids.gid()]),
            writer: None,
            reader: None,
            stamp: None,
            cancellation: runtime.cancellation(),
            stop: runtime.stop_budget(),
            deadline: end,
            attempted: false,
            published: false,
            closed: false,
            close_unknown: false,
            failed: AtomicBool::new(false),
        })
    }
    /// Called only while the actual outer bootstrap/operation owner retains
    /// this value and brackets the call with its fresh original-origin checks.
    pub fn publish(&mut self) -> Result<()> {
        need(
            !self.attempted && !self.closed,
            "WORKER_POOL_PUBLICATION_REPLAYED",
        )?;
        self.attempted = true;
        let result = self.publish_once();
        self.latch(result)
    }
    fn publish_once(&mut self) -> Result<()> {
        self.check()?;
        self.assert_source_current()?;
        self.directories.open_root()?;
        self.check()?;
        for index in 1..=3 {
            self.directories.open_child(index)?;
            self.check()?;
        }
        self.assert_source_current()?;
        self.check()?;
        self.write_version()?;
        self.check()?;
        self.directories.sync()?;
        self.check()?;
        self.observe_version()?;
        self.assert_source_current()?;
        self.check()?;
        self.published = true;
        Ok(())
    }
    fn check(&self) -> Result<()> {
        let end = self
            .stop
            .deadline()
            .map_or(self.deadline, |stop| self.deadline.min(stop));
        need(
            !self.closed
                && !self.close_unknown
                && !self.failed.load(Ordering::Acquire)
                && !self.cancellation.is_cancelled()
                && Instant::now() < end,
            "WORKER_POOL_PUBLICATION_CLOSED_OR_EXPIRED",
        )
    }
    fn assert_source_current(&self) -> Result<()> {
        if let Some(source) = &self.source {
            source.assert_current()?;
        }
        Ok(())
    }
    pub fn assert_current(&self) -> Result<()> {
        self.latch(self.current())
    }
    fn current(&self) -> Result<()> {
        self.check()?;
        need(self.published, "WORKER_POOL_BIRTH_NOT_PUBLISHED")?;
        self.observe_version()?;
        self.assert_source_current()?;
        self.check()
    }
    pub fn reference_data(&self) -> Result<PublishedControllerBirthData> {
        self.latch(self.reference())
    }
    fn reference(&self) -> Result<PublishedControllerBirthData> {
        self.assert_current()?;
        let info = self.reader.as_ref().expect("published reader").metadata()?;
        use std::os::unix::fs::MetadataExt;
        Ok(PublishedControllerBirthData {
            filename: self.filename.clone(),
            digest: self.digest,
            directory: self.directories.version_identity()?,
            file: [info.dev(), info.ino()],
        })
    }
    pub fn birth_data(&self) -> &ControllerBirthV2 {
        self.birth.identity()
    }
    pub fn retained_anchor(&self) -> Option<&RetainedPoolAnchor> {
        self.birth.retained_anchor()
    }
    pub(super) fn service_birth(&self) -> &ControllerServiceBirth {
        &self.birth
    }
    fn latch<T>(&self, result: Result<T>) -> Result<T> {
        if result.is_err() {
            self.failed.store(true, Ordering::Release);
        }
        result
    }
    /// Metadata close only. No version unlink, process stop, fence release or
    /// installed-pool/global acknowledgment is implied, even on success.
    pub fn close(&mut self) -> Result<()> {
        self.closed = true;
        let writer = self
            .writer
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let reader = self
            .reader
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let directories = self.directories.close();
        let result = finalized(finalized(writer, reader), directories);
        self.close_unknown |= result.is_err();
        result?;
        need(!self.close_unknown, "WORKER_POOL_PUBLICATION_CLOSE_UNKNOWN")
    }
}
impl Drop for ControllerBirthPublication {
    fn drop(&mut self) {
        std::mem::forget(self.writer.take());
        std::mem::forget(self.reader.take());
    }
}
