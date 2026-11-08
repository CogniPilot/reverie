//! Fixed read-only container policy mount. No request-selected host pathname.
use super::*;
use crate::native;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
};

const DIRECTORY: &str = "/run/reverie-worker-pool/policies";

pub struct ControllerPoolPolicy {
    data: WorkerPoolPolicy,
    digest: [u8; 32],
    file: Option<File>,
    directory: Option<File>,
    filename: String,
    directory_identity: (u64, u64),
    identity: (u64, u64),
    close_unknown: bool,
    controller: super::namespace::ControllerProcessObservation,
    engine: super::engine::EngineObserver,
}
impl ControllerPoolPolicy {
    /// Startup supplies the hash of the owner-selected read-only Docker bind.
    /// This is an explicit root-controller bootstrap, never a wire constructor.
    pub fn open(expected_sha256: [u8; 32]) -> Result<Self> {
        need(
            nix::unistd::geteuid().is_root(),
            "WORKER_POOL_CONTROLLER_ROOT_REQUIRED",
        )?;
        let controller = super::namespace::assert_controller_namespaces()?;
        let directory = native::open_at(
            nix::libc::AT_FDCWD,
            std::ffi::OsStr::new(DIRECTORY),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?;
        let filename = format!("{}.json", digest_text(expected_sha256));
        let opened = native::open_at(
            directory.as_raw_fd(),
            std::ffi::OsStr::new(&filename),
            nix::libc::O_RDONLY | nix::libc::O_NONBLOCK,
        );
        let file = match opened {
            Ok(file) => file,
            Err(error) => {
                return finalized(
                    Err(error.into()),
                    native::close(directory).map_err(Into::into),
                );
            }
        };
        let captured = (|| {
            Ok((
                read_policy(&file, expected_sha256)?,
                file_identity(&file)?,
                directory.metadata()?,
            ))
        })();
        let (data, identity, dm) = match captured {
            Ok(value) => value,
            Err(error) => {
                return finalized(
                    Err(error),
                    finalized(
                        native::close(file).map_err(Into::into),
                        native::close(directory).map_err(Into::into),
                    ),
                );
            }
        };
        let engine = match super::engine::EngineObserver::capture() {
            Ok(engine) => engine,
            Err(error) => {
                return finalized(
                    Err(error),
                    finalized(
                        native::close(file).map_err(Into::into),
                        native::close(directory).map_err(Into::into),
                    ),
                );
            }
        };
        let mut owner = Self {
            data,
            digest: expected_sha256,
            identity,
            file: Some(file),
            directory: Some(directory),
            filename,
            directory_identity: (dm.dev(), dm.ino()),
            close_unknown: false,
            controller,
            engine,
        };
        match owner.assert_current() {
            Ok(()) => Ok(owner),
            Err(error) => finalized(Err(error), owner.close()),
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
        self.engine.verify_anchor(&self.data, id, pid, self.digest)
    }
    pub(super) fn assert_current(&self) -> Result<()> {
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
        let file = self
            .file
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let directory = self
            .directory
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let closed = finalized(file, directory);
        self.close_unknown |= closed.is_err();
        closed?;
        need(!self.close_unknown, "WORKER_POOL_POLICY_CLOSE_UNKNOWN")
    }
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
