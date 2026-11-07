//! Source goal_private.private_entry and preparation._policy_current read
//! phases. Native work and full worker validation remain separated so the
//! application can preserve the exact final stamp/owner-check ordering.
use super::*;
use crate::native::private_goal::{PathIdentity as Identity, identity};
use std::{fs::OpenOptions, os::unix::fs::OpenOptionsExt};
impl PolicyBinding {
    pub fn path(&self) -> &Path {
        &self.path
    }
    /// Only after the actual normal loader observed the written candidate.
    /// Reading a file updates DATA; it does not acknowledge applied config.
    pub fn observe_published_file(&mut self) -> Result<()> {
        let (signature, _raw) = private_entry(&self.path)?;
        self.signature = signature;
        Ok(())
    }
    /// Return actual read_metadata data for the application's real full worker
    /// validator. No native producer may follow its final assert below.
    pub fn read_for_validation(&self) -> Result<reverie_contracts::storage_identity::Metadata> {
        let (signature, _raw) = private_entry(&self.path)?;
        let parent = fs::symlink_metadata(self.path.parent().expect("captured parent"))?;
        need(
            signature.0 == self.signature.0
                && parent.is_dir()
                && parent.uid() == self.owner
                && parent.mode() & 0o7777 == 0o700
                && self.identity.device == parent.dev()
                && self.identity.inode == parent.ino(),
            "RESOURCE_PREPARATION_CONFIG_CHANGED",
        )?;
        Ok(storage_identity::read_metadata(
            &self.path,
            self.owner,
            reverie_contracts::operations_v1::MAX_BYTES,
        )?)
    }
    /// Metadata-only final checks, after every descriptor close and full worker
    /// validator has completed. Application owner-current check follows this.
    pub fn assert_named_current(&self) -> Result<()> {
        let current = fs::symlink_metadata(&self.path)?;
        let parent = fs::symlink_metadata(self.path.parent().expect("captured parent"))?;
        need(
            native::PolicyEntryStamp::of(&current) == self.signature.0
                && current.mode() & 0o7777 == 0o600
                && parent.dev() == self.identity.device
                && parent.ino() == self.identity.inode,
            "RESOURCE_PREPARATION_CONFIG_CHANGED",
        )
    }
}
fn private_entry(path: &Path) -> Result<(PolicyFileStamp, Vec<u8>)> {
    need(
        native::private_goal::path_available(path),
        "PRIVATE_GOAL_CONFIGURATION_UNAVAILABLE",
    )?;
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open("/")?;
    let mut descriptors = vec![root];
    let mut entries = Vec::new();
    let body = observe_entry(path, &mut descriptors, &mut entries).and_then(|result| {
        for (path, issued) in &entries {
            let fresh = fs::symlink_metadata(path)?;
            need(
                !fresh.file_type().is_symlink() && identity(&fresh) == *issued,
                "PRIVATE_GOAL_ANCESTRY_CHANGED",
            )?;
        }
        Ok(result)
    });
    let mut closed = Ok(());
    for file in descriptors.into_iter().rev() {
        closed = finalized(closed, native::close(file).map_err(Into::into));
    }
    finalized(body, closed)
}
fn observe_entry(
    path: &Path,
    descriptors: &mut Vec<File>,
    entries: &mut Vec<(PathBuf, Identity)>,
) -> Result<(PolicyFileStamp, Vec<u8>)> {
    let mut current = PathBuf::from("/");
    let parent = path.parent().expect("absolute leaf parent");
    for component in parent.components().skip(1) {
        current.push(component.as_os_str());
        let child = native::open_policy_child_directory(
            descriptors.last().expect("root"),
            component.as_os_str(),
        )?;
        descriptors.push(child);
        let info = descriptors.last().expect("owned child").metadata()?;
        need(
            native::private_goal::ancestry_available(&info),
            "PRIVATE_GOAL_ANCESTRY_UNAVAILABLE",
        )?;
        entries.push((current.clone(), identity(&info)));
    }
    let parent = descriptors.last().expect("owned parent");
    let info = parent.metadata()?;
    need(
        native::private_goal::parent_available(&info),
        "PRIVATE_GOAL_PARENT_UNAVAILABLE",
    )?;
    let file = native::open_policy_original(parent, path.file_name().expect("leaf"))?;
    descriptors.push(file);
    let file = descriptors.last_mut().expect("owned leaf");
    let info = file.metadata()?;
    need(
        native::private_goal::entry_available(&info, false),
        "PRIVATE_GOAL_ENTRY_UNAVAILABLE",
    )?;
    entries.push((path.to_owned(), identity(&info)));
    let maximum = reverie_contracts::operations_v1::MAX_BYTES;
    need(info.len() <= maximum as u64, "PRIVATE_GOAL_ENTRY_BOUND")?;
    let mut raw = Vec::new();
    while raw.len() <= maximum {
        let mut chunk = vec![0; 65536.min(maximum + 1 - raw.len())];
        let count = file.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..count]);
    }
    #[cfg(test)]
    native::test_faults::after_read(path)?;
    need(
        raw.len() <= maximum
            && native::PolicyEntryStamp::of(&file.metadata()?)
                == native::PolicyEntryStamp::of(&info),
        "PRIVATE_GOAL_ENTRY_CHANGED",
    )?;
    Ok((PolicyFileStamp(native::PolicyEntryStamp::of(&info)), raw))
}
