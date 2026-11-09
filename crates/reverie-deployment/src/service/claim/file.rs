use super::*;
use serde::Deserialize;
use std::os::unix::fs::MetadataExt;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    operation: String,
}

pub(super) struct ClaimFile {
    pub(super) path: PathBuf,
    pub(super) bytes: Vec<u8>,
    stamp: Stamp,
}
#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    links: u64,
    bytes: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl Stamp {
    fn capture(path: &Path) -> Result<Self> {
        installation::private(path, false)?;
        let m = std::fs::symlink_metadata(path)?;
        require(
            m.nlink() == 1 && m.len() <= 64 * 1024,
            "DEPLOYMENT_CLAIM_FILE_CHANGED",
        )?;
        Ok(Self {
            device: m.dev(),
            inode: m.ino(),
            uid: m.uid(),
            gid: m.gid(),
            mode: m.mode(),
            links: m.nlink(),
            bytes: m.len(),
            modified: (m.mtime(), m.mtime_nsec()),
            changed: (m.ctime(), m.ctime_nsec()),
        })
    }
}
impl ClaimFile {
    pub(super) fn capture_written(path: PathBuf, expected: &[u8]) -> Result<Self> {
        let captured = Self::capture(path)?;
        require(
            captured.bytes == expected,
            "DEPLOYMENT_WRITTEN_CLAIM_CHANGED",
        )?;
        Ok(captured)
    }
    pub(super) fn capture(path: PathBuf) -> Result<Self> {
        let stamp = Stamp::capture(&path)?;
        let bytes = installation::read_bounded(&path, 64 * 1024)?;
        require(
            stamp == Stamp::capture(&path)?,
            "DEPLOYMENT_CLAIM_FILE_CHANGED",
        )?;
        Ok(Self { path, bytes, stamp })
    }
    pub(super) fn selected(&self) -> Result<String> {
        require(self.bytes.len() <= 1024, "DEPLOYMENT_CLAIM_FILE_CHANGED")?;
        let selection: Selection = serde_json::from_slice(&self.bytes)?;
        Ok(selection.operation)
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        let current = Self::capture(self.path.clone())?;
        require(
            current.stamp == self.stamp && current.bytes == self.bytes,
            "DEPLOYMENT_CLAIM_FILE_CHANGED",
        )
    }
    pub(super) fn assert_renamed(&self, destination: &Path) -> Result<()> {
        let current = Self::capture(destination.to_owned())?;
        // Rename may change ctime; every other original inode/owner/content fact
        // must match the exact checked replacement, never just its operation ID.
        let mut expected = self.stamp.clone();
        expected.changed = current.stamp.changed;
        require(
            current.stamp == expected && current.bytes == self.bytes,
            "DEPLOYMENT_CLAIM_REPLACEMENT_UNCONFIRMED",
        )
    }
}
