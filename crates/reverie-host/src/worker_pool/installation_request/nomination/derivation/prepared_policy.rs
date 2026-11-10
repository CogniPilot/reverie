//! Prepared BirthV2 is immutable historical DATA, not an activated controller.
//! The original policy/file is retained even after the proposal's highs change.
use super::*;
use sha2::Digest;
use std::{ffi::OsStr, os::fd::AsRawFd};
#[derive(Default)]
pub(super) struct PreparedPolicyObservation {
    selected: Option<PathBuf>,
    policy: Option<WorkerPoolPolicy>,
    directory: Option<File>,
    file: Option<File>,
    directory_stamp: Option<native::PrivateFileStamp>,
    file_stamp: Option<native::PrivateFileStamp>,
    filename: Option<String>,
    raw: Option<Vec<u8>>,
    scan_error: Option<reverie_store::operations::JournalError>,
    close_error: Option<Box<PoolNominationError>>,
    close_attempted: bool,
}
impl PreparedPolicyObservation {
    pub(super) fn observe(&mut self, policy: &WorkerPoolPolicy) -> Result<()> {
        if let Some(original) = &self.policy {
            need(
                original == policy,
                "POOL_NOMINATION_PREPARED_POLICY_CHANGED",
            )?;
            return self.assert_current();
        }
        need(!self.close_attempted, "POOL_NOMINATION_PREPARED_CLOSED")?;
        self.policy = Some(policy.clone());
        let path = PathBuf::from(&policy.instance_root).join("worker-pool/policies");
        self.selected = Some(path.clone());
        let info = match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return self.assert_current(),
            Err(e) => return Err(e.into()),
            Ok(info) => info,
        };
        directory_custody(&info, policy)?;
        self.directory = Some(native::open_at(
            nix::libc::AT_FDCWD,
            path.as_os_str(),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?);
        self.directory_stamp = Some(native::PrivateFileStamp::of(
            &self
                .directory
                .as_ref()
                .expect("retained directory")
                .metadata()?,
        ));
        need(
            self.directory_stamp.as_ref() == Some(&native::PrivateFileStamp::of(&info)),
            "POOL_NOMINATION_PREPARED_DIRECTORY_CHANGED",
        )?;
        let names = match reverie_store::operations::settlement_directory_names(&path) {
            Ok(names) => names,
            Err(cause) => {
                self.scan_error = Some(cause);
                return Err(PoolNominationError::Refused(
                    "POOL_NOMINATION_PREPARED_SCAN",
                ));
            }
        };
        need(names.len() == 1, "POOL_NOMINATION_PREPARED_DIRECTORY")?;
        let filename = String::from_utf8(names[0].clone())
            .map_err(|_| PoolNominationError::Refused("POOL_NOMINATION_PREPARED_FILENAME"))?;
        let digest = filename
            .strip_suffix(".json")
            .and_then(|s| reverie_core::operations::JournalDigest::parse(s).ok())
            .ok_or(PoolNominationError::Refused(
                "POOL_NOMINATION_PREPARED_FILENAME",
            ))?;
        self.filename = Some(filename.clone());
        self.file = Some(native::open_at(
            self.directory
                .as_ref()
                .expect("original directory")
                .as_raw_fd(),
            OsStr::new(&filename),
            nix::libc::O_RDONLY | nix::libc::O_NONBLOCK,
        )?);
        let file = self.file.as_ref().expect("retained original file");
        let info = file.metadata()?;
        file_custody(&info, policy)?;
        self.file_stamp = Some(native::PrivateFileStamp::of(&info));
        // Existing policy reader verifies the RAW-byte digest and closed v2
        // decoder. Re-encoding proves this is exactly canonical prepared DATA.
        let digest_bytes = decode_digest(digest.as_str())?;
        let (selected, birth) = crate::worker_pool::policy::read_policy(file, digest_bytes, true)?;
        let birth = birth.ok_or(PoolNominationError::Refused(
            "POOL_NOMINATION_PREPARED_BIRTH",
        ))?;
        let raw = birth
            .encode()
            .map_err(|_| PoolNominationError::Refused("POOL_NOMINATION_PREPARED_BIRTH"))?;
        need(
            selected == *policy && format!("{:x}", sha2::Sha256::digest(&raw)) == digest.as_str(),
            "POOL_NOMINATION_PREPARED_POLICY_CHANGED",
        )?;
        self.raw = Some(raw);
        self.assert_current()
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        if let Some(error) = &self.close_error {
            return Err(PoolNominationError::Refused(error.code()));
        }
        need(self.scan_error.is_none(), "POOL_NOMINATION_PREPARED_SCAN")?;
        let Some(path) = &self.selected else {
            return Ok(());
        };
        let Some(stamp) = &self.directory_stamp else {
            return match fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.into()),
                Ok(_) => Err(PoolNominationError::Refused(
                    "POOL_NOMINATION_PREPARED_DIRECTORY_CHANGED",
                )),
            };
        };
        let policy = self.policy.as_ref().expect("original policy DATA");
        let info = fs::symlink_metadata(path)?;
        directory_custody(&info, policy)?;
        need(
            native::PrivateFileStamp::of(&info) == *stamp,
            "POOL_NOMINATION_PREPARED_DIRECTORY_CHANGED",
        )?;
        if let Some(directory) = &self.directory {
            need(
                native::PrivateFileStamp::of(&directory.metadata()?) == *stamp,
                "POOL_NOMINATION_PREPARED_DIRECTORY_CHANGED",
            )?;
        }
        let filename = self.filename.as_ref().ok_or(PoolNominationError::Refused(
            "POOL_NOMINATION_PREPARED_CAPTURE_INCOMPLETE",
        ))?;
        need(
            self.file_stamp.is_some() && self.raw.is_some(),
            "POOL_NOMINATION_PREPARED_CAPTURE_INCOMPLETE",
        )?;
        let file_info = fs::symlink_metadata(path.join(filename))?;
        file_custody(&file_info, policy)?;
        need(
            self.file_stamp.as_ref() == Some(&native::PrivateFileStamp::of(&file_info)),
            "POOL_NOMINATION_PREPARED_FILE_CHANGED",
        )?;
        if let Some(file) = &self.file {
            need(
                self.file_stamp.as_ref() == Some(&native::PrivateFileStamp::of(&file.metadata()?)),
                "POOL_NOMINATION_PREPARED_FILE_CHANGED",
            )?;
        }
        Ok(())
    }
    pub(super) fn close(&mut self) -> Result<()> {
        if !self.close_attempted {
            self.close_attempted = true;
            let file = self
                .file
                .take()
                .map_or(Ok(()), |f| native::close(f).map_err(Into::into));
            let directory = self
                .directory
                .take()
                .map_or(Ok(()), |f| native::close(f).map_err(Into::into));
            if let Err(cause) = finalized(file, directory) {
                self.close_error = Some(Box::new(cause));
            }
        }
        self.assert_current()
    }
}
impl Drop for PreparedPolicyObservation {
    fn drop(&mut self) {
        if !self.close_attempted || self.close_error.is_some() {
            std::mem::forget((
                self.file.take(),
                self.directory.take(),
                self.scan_error.take(),
                self.close_error.take(),
            ));
        }
    }
}
fn directory_custody(info: &fs::Metadata, policy: &WorkerPoolPolicy) -> Result<()> {
    need(
        info.is_dir()
            && info.uid() == policy.broker_uid
            && info.gid() == policy.broker_gid
            && info.mode() & 0o7777 == 0o750,
        "POOL_NOMINATION_PREPARED_DIRECTORY_CUSTODY",
    )
}
fn file_custody(info: &fs::Metadata, policy: &WorkerPoolPolicy) -> Result<()> {
    need(
        info.is_file()
            && info.uid() == policy.broker_uid
            && info.gid() == policy.broker_gid
            && info.mode() & 0o7777 == 0o440
            && info.nlink() == 1
            && info.len() > 0
            && info.len() <= 65536,
        "POOL_NOMINATION_PREPARED_FILE_CUSTODY",
    )
}
fn decode_digest(value: &str) -> Result<[u8; 32]> {
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| PoolNominationError::Refused("POOL_NOMINATION_PREPARED_FILENAME"))?;
    }
    Ok(bytes)
}
