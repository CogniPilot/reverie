//! Retained anchored policy-file transaction, never a reload/start permit.
//! Only a trusted installing service supplies its loader-selected policy path;
//! application admission/publication/custody fences remain mandatory outside.
#![forbid(unsafe_code)]
use super::*;
use reverie_contracts::reservation_policy::PolicyCandidateData;
use std::os::unix::fs::PermissionsExt;
use std::{
    ffi::OsString,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};
mod current;
#[cfg(test)]
mod tests;
/// Exact legacy five-field signature, supplied only by a real native read.
#[derive(Clone, Debug)]
pub struct PolicyFileStamp(native::PolicyEntryStamp);
impl PolicyFileStamp {
    pub fn assert_named_current(&self, path: &Path) -> Result<()> {
        need(
            native::PolicyEntryStamp::of(&fs::symlink_metadata(path)?) == self.0,
            "RESOURCE_PREPARATION_CONFIG_CHANGED",
        )
    }
}
pub struct PolicyTransaction {
    path: PathBuf,
    parent: PosixPath,
    name: OsString,
    owner: u32,
    directory: Option<File>,
    identity: native::ControlDirectorySnapshot,
    original: PolicyFileStamp,
    raw: Vec<u8>,
    temporary: Option<OsString>,
}
/// Native identity DATA retained across the policy publication and reload.
/// It has no public constructor and never authorizes either operation.
#[derive(Clone)]
pub struct PolicyBinding {
    path: PathBuf,
    owner: u32,
    identity: native::ControlDirectorySnapshot,
    signature: PolicyFileStamp,
}
pub fn publish_prepared_policy(
    config: &ReservationConfiguration,
    record: &reverie_contracts::reservation_policy::PreparedPolicyRecord,
) -> Result<()> {
    super::private_record::publish(
        config,
        super::private_record::PrivateRecord::PreparedPolicy(record),
    )
}
impl PolicyTransaction {
    pub fn capture(path: &Path, owner: u32) -> Result<Self> {
        let parent = path
            .parent()
            .ok_or(ControlHostError::Refused("RESERVATION_CONTROL_PATH"))?;
        let parent =
            PosixPath::try_new(&native::python_text(parent)).expect("native text codepoints");
        let name = path
            .file_name()
            .ok_or(ControlHostError::Refused("RESERVATION_CONTROL_PATH"))?
            .to_owned();
        let (directory, identity) = native::held_control_directory(&parent, owner)?;
        let body = (|| {
            let mut file = native::open_policy_original(&directory, &name)?;
            let observed = (|| {
                let original = private_file(&file)?;
                let mut raw = vec![0; reverie_contracts::operations_v1::MAX_BYTES + 1];
                // Preserve the source's single bounded read, not read_to_end.
                let count = file.read(&mut raw)?;
                raw.truncate(count);
                #[cfg(test)]
                native::test_faults::after_read(path)?;
                need(
                    raw.len() <= reverie_contracts::operations_v1::MAX_BYTES
                        && raw.len() as u64 == original.size
                        && private_file(&file)? == original,
                    "RESOURCE_PREPARATION_CONFIG_CHANGED",
                )?;
                Ok((PolicyFileStamp(original), raw))
            })();
            finalized(observed, native::close(file).map_err(Into::into))
        })();
        match body {
            Ok((original, raw)) => Ok(Self {
                path: path.to_owned(),
                parent,
                name,
                owner,
                directory: Some(directory),
                identity,
                original,
                raw,
                temporary: None,
            }),
            Err(error) => finalized(Err(error), native::close(directory).map_err(Into::into)),
        }
    }
    pub fn original_bytes(&self) -> &[u8] {
        &self.raw
    }
    pub fn original_stamp(&self) -> &PolicyFileStamp {
        &self.original
    }
    pub fn binding(&self) -> PolicyBinding {
        PolicyBinding {
            path: self.path.clone(),
            owner: self.owner,
            identity: self.identity,
            signature: self.original.clone(),
        }
    }
    /// Fixed durable attempt then exact original-raw evidence, in source order.
    /// The retained application must latch its one attempt before invoking this.
    pub fn publish_attempt(
        &self,
        config: &ReservationConfiguration,
        operation: &reverie_core::operations::JournalId,
        before: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        candidate: &PolicyCandidateData,
    ) -> Result<()> {
        let record =
            reverie_contracts::reservation_policy::PolicyAttemptRecord::from_observed_data(
                operation, before, candidate,
            )
            .map_err(ControlHostError::PolicyData)?;
        super::private_record::publish(
            config,
            super::private_record::PrivateRecord::PolicyAttempt(&record),
        )?;
        super::private_record::publish(
            config,
            super::private_record::PrivateRecord::PolicyBefore(operation, &self.raw),
        )
    }
    pub fn write_candidate(&mut self, candidate: &PolicyCandidateData) -> Result<()> {
        need(
            self.temporary.is_none(),
            "RESOURCE_PREPARATION_CONFIG_ALREADY_ATTEMPTED",
        )?;
        let name = OsString::from(
            reverie_store::operations::allocate_policy_temporary_name()
                .map_err(ControlHostError::Journal)?,
        );
        self.temporary = Some(name.clone());
        let mut file = native::create_policy_temporary(
            self.directory.as_ref().expect("live transaction"),
            &name,
        )?;
        let body = (|| {
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
            file.write_all(candidate.bytes()).map_err(write_error)?;
            file.sync_all()?;
            Ok(())
        })();
        finalized(body, native::close(file).map_err(Into::into))
    }
    pub fn assert_directory_current(&self) -> Result<()> {
        let (fresh, identity) = native::held_control_directory(&self.parent, self.owner)?;
        let body = need(
            identity == self.identity,
            "RESOURCE_PREPARATION_CONFIG_DIRECTORY_CHANGED",
        );
        finalized(body, native::close(fresh).map_err(Into::into))
    }
    /// Adjacent anchored original-signature CAS, rename+directory fsync, and
    /// checked close before any later loader/native observation. Failures keep
    /// all attempts/temporaries; no rollback, deletion or retry is performed.
    pub fn publish(mut self) -> Result<()> {
        let body = (|| {
            let directory = self.directory.as_ref().expect("live transaction");
            let temporary = self.temporary.as_ref().ok_or(ControlHostError::Refused(
                "RESOURCE_PREPARATION_CONFIG_INTENT_REQUIRED",
            ))?;
            need(
                native::named_policy_entry(directory, &self.name)? == self.original.0,
                "RESOURCE_PREPARATION_CONFIG_CHANGED",
            )?;
            native::replace_policy(directory, temporary, &self.name)?;
            directory.sync_all()?;
            Ok(())
        })();
        finalized(body, self.close_owned())
    }
    pub fn close(mut self) -> Result<()> {
        self.close_owned()
    }
    fn close_owned(&mut self) -> Result<()> {
        self.directory
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into))
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}
fn write_error(error: io::Error) -> ControlHostError {
    if error.kind() == io::ErrorKind::WriteZero {
        ControlHostError::Refused("RESOURCE_PREPARATION_SHORT_WRITE")
    } else {
        error.into()
    }
}
fn private_file(file: &File) -> Result<native::PolicyEntryStamp> {
    let info = file.metadata()?;
    need(
        info.is_file()
            && info.mode() & 0o7777 == 0o600
            && info.uid() == native::policy_effective_uid()
            && info.nlink() == 1,
        "PRIVATE_FILE",
    )?;
    Ok(native::PolicyEntryStamp::of(&info))
}
fn finalized<T>(body: Result<T>, closed: Result<()>) -> Result<T> {
    match (body, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(ControlHostError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
