//! Fixed private draft publication. Paths derive only from captured installing
//! configuration and checked draft IDs; no public raw writer is exposed.
use super::*;
use reverie_contracts::{reservation_draft::DraftRecord, storage_identity::Metadata};
use reverie_core::operations::JournalId;
use std::{
    fs::OpenOptions,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
};

pub fn read_draft(config: &ReservationConfiguration, id: &JournalId) -> Result<Metadata> {
    super::history::read_receipt(config, &format!("draft-{}.json", id.as_str()))
}
pub fn publish_draft(config: &ReservationConfiguration, record: &DraftRecord) -> Result<()> {
    let path = native::python_path(
        &operation_leaf(config, &format!("draft-{}.json", record.id().as_str()))?.codepoints(),
    )?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)?;
    let body = (|| {
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        // The original creates the exclusive file before serializing it. A
        // later encoding/write/fsync failure retains the partial name.
        let bytes = record.canonical_bytes().map_err(ControlHostError::Draft)?;
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
    let closed = native::close(file).map_err(Into::into);
    finalized_control(body, closed)?;
    let parent = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path.parent().expect("fixed operations parent"))?;
    let synced = parent.sync_all().map_err(Into::into);
    finalized_control(synced, native::close(parent).map_err(Into::into))
}
fn finalized_control<T>(body: Result<T>, closed: Result<()>) -> Result<T> {
    match (body, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(ControlHostError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
