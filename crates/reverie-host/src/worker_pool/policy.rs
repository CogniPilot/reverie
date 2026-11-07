//! Fixed read-only container policy mount. No request-selected host pathname.
use super::*;
use crate::native;
use sha2::{Digest, Sha256};
use std::{fs::File, os::unix::fs::MetadataExt};

const POLICY: &str = "/run/reverie-worker-pool/policy.json";

pub struct ControllerPoolPolicy {
    data: WorkerPoolPolicy,
    digest: [u8; 32],
    file: Option<File>,
    identity: (u64, u64),
    close_unknown: bool,
}
impl ControllerPoolPolicy {
    /// Startup supplies the hash of the owner-selected read-only Docker bind.
    /// This is an explicit root-controller bootstrap, never a wire constructor.
    pub fn open(expected_sha256: [u8; 32]) -> Result<Self> {
        need(
            nix::unistd::geteuid().is_root(),
            "WORKER_POOL_CONTROLLER_ROOT_REQUIRED",
        )?;
        super::namespace::assert_controller_namespaces()?;
        let file = native::open_at(
            nix::libc::AT_FDCWD,
            std::ffi::OsStr::new(POLICY),
            nix::libc::O_RDONLY | nix::libc::O_NONBLOCK,
        )?;
        let captured = (|| Ok((read_policy(&file, expected_sha256)?, file_identity(&file)?)))();
        let (data, identity) = match captured {
            Ok(value) => value,
            Err(error) => return finalized(Err(error), native::close(file).map_err(Into::into)),
        };
        let mut owner = Self {
            data,
            digest: expected_sha256,
            identity,
            file: Some(file),
            close_unknown: false,
        };
        match owner.assert_current() {
            Ok(()) => Ok(owner),
            Err(error) => finalized(Err(error), owner.close()),
        }
    }
    pub fn data(&self) -> &WorkerPoolPolicy {
        &self.data
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        super::namespace::assert_controller_namespaces()?;
        let file = self
            .file
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_POLICY_CLOSED"))?;
        need(
            file_identity(file)? == self.identity,
            "WORKER_POOL_POLICY_CHANGED",
        )?;
        let flags = nix::sys::statvfs::fstatvfs(file)
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
        )
    }
    pub(super) fn close(&mut self) -> Result<()> {
        if let Some(file) = self.file.take() {
            let closed = native::close(file).map_err(PoolError::from);
            self.close_unknown |= closed.is_err();
            closed?;
        }
        need(!self.close_unknown, "WORKER_POOL_POLICY_CLOSE_UNKNOWN")
    }
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
