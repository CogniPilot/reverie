//! Fixed read-only container policy mount. No request-selected host pathname.
use super::*;
use crate::native;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    sync::atomic::{AtomicBool, Ordering},
};

const DIRECTORY: &str = "/run/reverie-worker-pool/policies";
#[cfg(test)]
mod tests;

pub struct ControllerPoolPolicy {
    data: WorkerPoolPolicy,
    digest: [u8; 32],
    file: Option<File>,
    directory: Option<File>,
    filename: String,
    directory_identity: (u64, u64),
    identity: (u64, u64),
    close_unknown: AtomicBool,
    closed: bool,
    controller: super::namespace::ControllerProcessObservation,
    engine: super::engine::EngineObserver,
}
impl ControllerPoolPolicy {
    /// Startup supplies the hash of the owner-selected read-only Docker bind.
    /// This is an explicit root-controller bootstrap, never a wire constructor.
    pub fn open(
        expected_sha256: [u8; 32],
    ) -> std::result::Result<Self, Box<ControllerPoolPolicyFailure>> {
        // Allocate the actual partial owner before the first native check or
        // open. Every returned descriptor is stored before the next operation.
        let mut opening = OpeningPolicy::new(expected_sha256);
        let result = (|| {
            need(
                nix::unistd::geteuid().is_root(),
                "WORKER_POOL_CONTROLLER_ROOT_REQUIRED",
            )?;
            opening.controller = Some(super::namespace::assert_controller_namespaces()?);
            opening.open_directory(std::path::Path::new(DIRECTORY))?;
            opening.open_file()?;
            opening.capture_policy()?;
            opening.engine = Some(super::engine::EngineObserver::capture()?);
            Ok(())
        })();
        if let Err(primary) = result {
            return Err(ControllerPoolPolicyFailure::opening(opening, primary));
        }
        Self::finish_open(opening)
    }
    fn finish_open(
        opening: OpeningPolicy,
    ) -> std::result::Result<Self, Box<ControllerPoolPolicyFailure>> {
        let owner = opening.into_policy();
        match owner.assert_current() {
            Ok(()) => Ok(owner),
            Err(primary) => Err(Box::new(ControllerPoolPolicyFailure {
                owner: Some(FailureOwner::Opened(owner)),
                primary,
                known_closed: false,
            })),
        }
    }
    pub fn data(&self) -> &WorkerPoolPolicy {
        &self.data
    }
    pub fn version_directory_identity(&self) -> (u64, u64) {
        self.directory_identity
    }
    pub fn version_digest_data(&self) -> [u8; 32] {
        self.digest
    }
    pub(super) fn assert_anchor(&self, id: &str, pid: u32) -> Result<()> {
        self.require_open()?;
        self.engine.verify_anchor(&self.data, id, pid, self.digest)
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        self.require_open()?;
        let result = self.observe_current();
        if result.as_ref().is_err_and(PoolError::close_unknown) {
            self.close_unknown.store(true, Ordering::Release);
        }
        result
    }
    fn require_open(&self) -> Result<()> {
        need(
            !self.closed && !self.close_unknown.load(Ordering::Acquire),
            "WORKER_POOL_POLICY_CLOSED",
        )
    }
    fn observe_current(&self) -> Result<()> {
        need(
            super::namespace::assert_controller_namespaces()? == self.controller,
            "WORKER_POOL_CONTROLLER_CHANGED",
        )?;
        self.engine
            .verify(&self.data, &self.controller, self.digest)?;
        let file = self
            .file
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_POLICY_CLOSED"))?;
        let directory = self
            .directory
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_POLICY_CLOSED"))?;
        let dm = directory.metadata()?;
        let fm = file.metadata()?;
        need(
            dm.is_dir()
                && (dm.dev(), dm.ino()) == self.directory_identity
                && dm.uid() == self.data.broker_uid
                && dm.gid() == self.data.broker_gid
                && dm.mode() & 0o7777 == 0o750
                && fm.uid() == self.data.broker_uid
                && fm.gid() == self.data.broker_gid
                && fm.mode() & 0o7777 == 0o440
                && nix::unistd::getegid().as_raw() == self.data.broker_gid,
            "WORKER_POOL_POLICY_VERSION_CUSTODY",
        )?;
        need(
            file_identity(file)? == self.identity,
            "WORKER_POOL_POLICY_CHANGED",
        )?;
        let flags = nix::sys::statvfs::fstatvfs(directory)
            .map_err(|_| PoolError::Refused("WORKER_POOL_POLICY_MOUNT_UNKNOWN"))?;
        need(
            flags
                .flags()
                .contains(nix::sys::statvfs::FsFlags::ST_RDONLY),
            "WORKER_POOL_POLICY_READONLY_REQUIRED",
        )?;
        need(
            read_policy(file, self.digest)? == self.data,
            "WORKER_POOL_POLICY_CHANGED",
        )?;
        let named = native::open_at(
            directory.as_raw_fd(),
            std::ffi::OsStr::new(&self.filename),
            nix::libc::O_RDONLY | nix::libc::O_NONBLOCK,
        )?;
        let result = (|| {
            need(
                file_identity(&named)? == self.identity,
                "WORKER_POOL_POLICY_VERSION_REBOUND",
            )
        })();
        finalized(result, native::close(named).map_err(Into::into))
    }
    /// Finalize only these opened metadata descriptors. This stops no anchor
    /// or worker and does not complete maintenance or release pool capacity.
    pub fn close(&mut self) -> Result<()> {
        self.closed = true;
        let closed = finalized(
            close_files(&mut self.file, &mut self.directory),
            self.engine.require_closed(),
        );
        if closed.is_err() {
            self.close_unknown.store(true, Ordering::Release);
        }
        closed?;
        need(
            !self.close_unknown.load(Ordering::Acquire),
            "WORKER_POOL_POLICY_CLOSE_UNKNOWN",
        )
    }
}

struct OpeningPolicy {
    digest: [u8; 32],
    filename: String,
    file: Option<File>,
    directory: Option<File>,
    controller: Option<super::namespace::ControllerProcessObservation>,
    engine: Option<super::engine::EngineObserver>,
    captured: Option<CapturedPolicy>,
    close_unknown: bool,
}
struct CapturedPolicy {
    data: WorkerPoolPolicy,
    identity: (u64, u64),
    directory_identity: (u64, u64),
}
impl OpeningPolicy {
    fn new(digest: [u8; 32]) -> Self {
        Self {
            digest,
            filename: format!("{}.json", digest_text(digest)),
            file: None,
            directory: None,
            controller: None,
            engine: None,
            captured: None,
            close_unknown: false,
        }
    }
    fn open_directory(&mut self, path: &std::path::Path) -> Result<()> {
        self.directory = Some(native::open_at(
            nix::libc::AT_FDCWD,
            path.as_os_str(),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?);
        Ok(())
    }
    fn open_file(&mut self) -> Result<()> {
        self.file = Some(native::open_at(
            self.directory.as_ref().expect("opening order").as_raw_fd(),
            std::ffi::OsStr::new(&self.filename),
            nix::libc::O_RDONLY | nix::libc::O_NONBLOCK,
        )?);
        Ok(())
    }
    fn capture_policy(&mut self) -> Result<()> {
        let file = self.file.as_ref().expect("opening order");
        let data = read_policy(file, self.digest)?;
        let identity = file_identity(file)?;
        let directory = self.directory.as_ref().expect("opening order").metadata()?;
        self.captured = Some(CapturedPolicy {
            data,
            identity,
            directory_identity: (directory.dev(), directory.ino()),
        });
        Ok(())
    }
    fn into_policy(mut self) -> ControllerPoolPolicy {
        let CapturedPolicy {
            data,
            identity,
            directory_identity,
        } = self.captured.take().expect("successful capture");
        ControllerPoolPolicy {
            data,
            identity,
            directory_identity,
            digest: self.digest,
            filename: self.filename,
            file: self.file,
            directory: self.directory,
            controller: self.controller.expect("successful capture"),
            engine: self.engine.expect("successful capture"),
            close_unknown: AtomicBool::new(self.close_unknown),
            closed: false,
        }
    }
    fn close(&mut self) -> Result<()> {
        let engine = self
            .engine
            .as_ref()
            .map_or(Ok(()), super::engine::EngineObserver::require_closed);
        let closed = finalized(close_files(&mut self.file, &mut self.directory), engine);
        self.close_unknown |= closed.is_err();
        closed?;
        need(!self.close_unknown, "WORKER_POOL_POLICY_CLOSE_UNKNOWN")
    }
}
enum FailureOwner {
    Opening(OpeningPolicy),
    Opened(ControllerPoolPolicy),
}
/// Owns the original partial policy, descriptors, controller observation and
/// Engine observer on refusal. No automatic close or error-only conversion.
pub struct ControllerPoolPolicyFailure {
    owner: Option<FailureOwner>,
    primary: PoolError,
    known_closed: bool,
}
impl ControllerPoolPolicyFailure {
    fn opening(mut owner: OpeningPolicy, primary: PoolError) -> Box<Self> {
        owner.close_unknown |= primary.close_unknown();
        Box::new(Self {
            owner: Some(FailureOwner::Opening(owner)),
            primary,
            known_closed: false,
        })
    }
    pub fn primary_error(&self) -> &PoolError {
        &self.primary
    }
    pub fn close(&mut self) -> Result<()> {
        let result = match self.owner.as_mut().expect("retained failure owner") {
            FailureOwner::Opening(owner) => owner.close(),
            FailureOwner::Opened(owner) => owner.close(),
        };
        self.known_closed = result.is_ok();
        result
    }
}
impl Drop for ControllerPoolPolicyFailure {
    fn drop(&mut self) {
        if !self.known_closed {
            // Dropping an error is never a checked receipt. The actual outer
            // operation must retain this failure for supported reconciliation.
            std::mem::forget(self.owner.take());
        }
    }
}
fn close_files(file: &mut Option<File>, directory: &mut Option<File>) -> Result<()> {
    let file = file
        .take()
        .map(native::close)
        .transpose()
        .map(|_| ())
        .map_err(Into::into);
    let directory = directory
        .take()
        .map(native::close)
        .transpose()
        .map(|_| ())
        .map_err(Into::into);
    finalized(file, directory)
}
fn digest_text(digest: [u8; 32]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn file_identity(file: &File) -> Result<(u64, u64)> {
    let metadata = file.metadata()?;
    need(
        metadata.is_file()
            && metadata.nlink() == 1
            && metadata.len() <= 65_536
            && metadata.mode() & 0o022 == 0,
        "WORKER_POOL_POLICY_CUSTODY",
    )?;
    Ok((metadata.dev(), metadata.ino()))
}
fn read_policy(file: &File, digest: [u8; 32]) -> Result<WorkerPoolPolicy> {
    use std::os::unix::fs::FileExt;
    let mut raw = [0u8; 65_537];
    let count = file.read_at(&mut raw, 0)?;
    need(count > 0 && count <= 65_536, "WORKER_POOL_POLICY_BOUND")?;
    let actual: [u8; 32] = Sha256::digest(&raw[..count]).into();
    need(actual == digest, "WORKER_POOL_POLICY_DIGEST")?;
    WorkerPoolPolicy::decode(&raw[..count])
        .map_err(|_| PoolError::Refused("WORKER_POOL_POLICY_INVALID"))
}
