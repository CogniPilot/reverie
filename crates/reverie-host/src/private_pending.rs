//! One internal regular-file pending owner. GPU and pool purposes select their
//! own fixed paths/intent checks; this layer exposes no public writer or grant.
#![forbid(unsafe_code)]
use crate::{ObservationError, native};
use std::{
    fs::{self, File},
    io::{self, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Instant,
};
#[derive(Debug)]
pub(crate) enum PendingError {
    Io(io::Error),
    Native(ObservationError),
    Parent,
    Private,
    AlreadyAttempted,
    Changed,
    Deadline,
    Finalized {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
    PublicationUnknown(Box<Self>),
}
impl From<io::Error> for PendingError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<ObservationError> for PendingError {
    fn from(value: ObservationError) -> Self {
        Self::Native(value)
    }
}
type Result<T> = std::result::Result<T, PendingError>;
#[derive(Clone, Copy, Eq, PartialEq)]
enum Release {
    NotSubmitted,
    Attempted,
    Confirmed,
}
pub(crate) struct PendingFile {
    path: PathBuf,
    stamp: native::PrivateFileStamp,
    release: Release,
}
impl PendingFile {
    /// Caller latches its attempt before entry. Take the actual parent FD so
    /// every file and parent finalizer finishes before minting the local owner.
    pub(crate) fn create(directory: File, path: PathBuf, bytes: &[u8], owner: u32) -> Result<Self> {
        Self::create_selected(directory, path, bytes, owner, None)
    }
    pub(crate) fn create_with_stop(
        directory: File,
        path: PathBuf,
        bytes: &[u8],
        owner: u32,
        end: Instant,
        stop: &crate::worker_runtime::WorkerStopBudget,
    ) -> Result<Self> {
        Self::create_selected(directory, path, bytes, owner, Some((end, stop)))
    }
    fn create_selected(
        directory: File,
        path: PathBuf,
        bytes: &[u8],
        owner: u32,
        bound: Option<(Instant, &crate::worker_runtime::WorkerStopBudget)>,
    ) -> Result<Self> {
        let body = (|| {
            let name = path.file_name().ok_or(PendingError::Parent)?;
            if let Some((end, stop)) = bound
                && Instant::now() >= stop.deadline().map_or(end, |stop| end.min(stop))
            {
                return Err(PendingError::Deadline);
            }
            let mut file = native::create_policy_temporary(&directory, name)?;
            let written = write_pending(&mut file, bytes, owner);
            let stamp = finalized(written, native::close(file).map_err(Into::into))?;
            directory.sync_all()?;
            Ok(stamp)
        })();
        let stamp = finalized(body, native::close(directory).map_err(Into::into))?;
        Ok(Self {
            path,
            stamp,
            release: Release::NotSubmitted,
        })
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn stamp(&self) -> &native::PrivateFileStamp {
        &self.stamp
    }
    pub(crate) fn unreleased(&self) -> bool {
        self.release == Release::NotSubmitted
    }
    pub(crate) fn confirmed(&self) -> bool {
        self.release == Release::Confirmed
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        if !self.unreleased() {
            return Err(PendingError::AlreadyAttempted);
        }
        let named = native::PrivateFileStamp::of(&fs::symlink_metadata(&self.path)?);
        if named != self.stamp {
            return Err(PendingError::Changed);
        }
        Ok(())
    }
    /// LAST cooperative unlink, after domain-specific terminal checks. There
    /// is no owned descriptor close after unlink and no Drop/retry cleanup.
    pub(crate) fn release(&mut self, end: Option<Instant>) -> Result<()> {
        self.assert_current()?;
        self.unlink_before(end)
    }
    /// Original pool budget, read after the final named-file check and directly
    /// before the one unlink. This never constructs a grace or replacement budget.
    pub(crate) fn release_with_stop(
        &mut self,
        end: Instant,
        stop: &crate::worker_runtime::WorkerStopBudget,
    ) -> Result<()> {
        self.assert_current()?;
        self.unlink_before(Some(stop.deadline().map_or(end, |stop| end.min(stop))))
    }
    fn unlink_before(&mut self, end: Option<Instant>) -> Result<()> {
        if end.is_some_and(|end| Instant::now() >= end) {
            return Err(PendingError::Deadline);
        }
        self.release = Release::Attempted;
        fs::remove_file(&self.path)
            .map_err(|error| PendingError::PublicationUnknown(Box::new(error.into())))?;
        self.release = Release::Confirmed;
        Ok(())
    }
}
fn write_pending(file: &mut File, bytes: &[u8], owner: u32) -> Result<native::PrivateFileStamp> {
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    let stamp = native::PrivateFileStamp::of(&file.metadata()?);
    if !stamp.private(owner) {
        return Err(PendingError::Private);
    }
    Ok(stamp)
}
fn finalized<T>(body: Result<T>, closed: Result<()>) -> Result<T> {
    match (body, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(PendingError::Finalized {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
