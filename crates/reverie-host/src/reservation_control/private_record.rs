//! Shared exclusive publication/finalizer owner for the two actual named
//! private record purposes. No public path/bytes writer or policy callback.
use super::*;
use reverie_contracts::{
    reservation_draft::DraftRecord, reservation_publication::PublicationIntent,
};
use std::{
    fs::OpenOptions,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
};
pub(super) enum PrivateRecord<'a> {
    Draft(&'a DraftRecord),
    Publication(&'a PublicationIntent),
    PolicyAttempt(&'a reverie_contracts::reservation_policy::PolicyAttemptRecord),
    PolicyBefore(&'a reverie_core::operations::JournalId, &'a [u8]),
    PreparedPolicy(&'a reverie_contracts::reservation_policy::PreparedPolicyRecord),
}
impl PrivateRecord<'_> {
    fn name(&self) -> String {
        match self {
            Self::Draft(value) => format!("draft-{}.json", value.id().as_str()),
            Self::Publication(value) => {
                format!("publication-{}.json", value.operation_id().as_str())
            }
            Self::PolicyAttempt(value) => {
                format!("config-attempt-{}.json", value.operation_id().as_str())
            }
            Self::PolicyBefore(operation, _) => {
                format!("config-before-{}.json", operation.as_str())
            }
            Self::PreparedPolicy(value) => {
                format!("prepared-{}.json", value.operation_id().as_str())
            }
        }
    }
    fn bytes(&self) -> Result<Vec<u8>> {
        match self {
            Self::Draft(value) => value.canonical_bytes().map_err(ControlHostError::Draft),
            Self::Publication(value) => Ok(value.canonical_bytes()),
            Self::PolicyAttempt(value) => Ok(value.canonical_bytes().to_vec()),
            Self::PolicyBefore(_, raw) => {
                need(
                    raw.len() <= reverie_contracts::operations_v1::MAX_BYTES,
                    "RESOURCE_PREPARATION_CONFIG_BOUND",
                )?;
                Ok(raw.to_vec())
            }
            Self::PreparedPolicy(value) => Ok(value.canonical_bytes().to_vec()),
        }
    }
}
pub(super) fn publish(config: &ReservationConfiguration, record: PrivateRecord<'_>) -> Result<()> {
    let path = native::python_path(&operation_leaf(config, &record.name())?.codepoints())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)?;
    let body = (|| {
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        let bytes = record.bytes()?;
        file.write_all(&bytes).map_err(|error| {
            if error.kind() == io::ErrorKind::WriteZero {
                ControlHostError::Refused("RESERVATION_SHORT_WRITE")
            } else {
                error.into()
            }
        })?;
        file.sync_all()?;
        Ok(())
    })();
    finalized(body, native::close(file).map_err(Into::into))?;
    let parent = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path.parent().expect("fixed operations parent"))?;
    let synced = parent.sync_all().map_err(Into::into);
    finalized(synced, native::close(parent).map_err(Into::into))
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
