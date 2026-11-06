//! Actual fixed private publication-intent observations. Stamps are metadata
//! DATA only; they cannot authorize company publication, reload or launch.
use super::*;
use reverie_contracts::reservation_publication::PublicationIntent;
use reverie_core::operations::JournalId;
use std::path::PathBuf;
pub struct PublicationStamp {
    path: PathBuf,
    device: u64,
    inode: u64,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}
impl PublicationStamp {
    fn capture(path: PathBuf, value: &fs::Metadata) -> Self {
        Self {
            path,
            device: value.dev(),
            inode: value.ino(),
            size: value.len(),
            mtime: (value.mtime(), value.mtime_nsec()),
            ctime: (value.ctime(), value.ctime_nsec()),
        }
    }
    fn matches(&self, value: &fs::Metadata) -> bool {
        self.device == value.dev()
            && self.inode == value.ino()
            && self.size == value.len()
            && self.mtime == (value.mtime(), value.mtime_nsec())
            && self.ctime == (value.ctime(), value.ctime_nsec())
    }
    /// Named metadata only; no descriptor finalizer or native producer follows.
    pub fn assert_named_current(&self) -> Result<()> {
        need(
            self.matches(&fs::symlink_metadata(&self.path)?),
            "RESOURCE_PREPARATION_PHASE_CHANGED",
        )
    }
}
fn path(config: &ReservationConfiguration, id: &JournalId) -> Result<PathBuf> {
    Ok(native::python_path(
        &operation_leaf(config, &format!("publication-{}.json", id.as_str()))?.codepoints(),
    )?)
}
pub fn publish_publication(
    config: &ReservationConfiguration,
    receipt: &PublicationIntent,
) -> Result<PublicationStamp> {
    super::private_record::publish(
        config,
        super::private_record::PrivateRecord::Publication(receipt),
    )?;
    let path = path(config, &receipt.operation_id())?;
    let info = fs::symlink_metadata(&path)?;
    Ok(PublicationStamp::capture(path, &info))
}
pub fn observe_publication(
    config: &ReservationConfiguration,
    id: &JournalId,
    expected: &PublicationStamp,
    receipt: &PublicationIntent,
) -> Result<PublicationStamp> {
    let path = path(config, id)?;
    let before = fs::symlink_metadata(&path)?;
    need(
        before.is_file()
            && before.mode() & 0o7777 == 0o600
            && before.uid() == config.uid()?
            && before.nlink() == 1
            && expected.path == path
            && expected.matches(&before),
        "RESOURCE_PREPARATION_PHASE_CHANGED",
    )?;
    let data = storage_identity::read_metadata(
        &path,
        config.uid()?,
        reverie_contracts::operations_v1::MAX_BYTES,
    )?;
    need(
        receipt.matches_metadata(&data),
        "RESOURCE_PREPARATION_PHASE_CHANGED",
    )?;
    Ok(PublicationStamp::capture(path, &before))
}
