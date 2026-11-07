//! Pinned files for the one installed memory database. These observations do
//! not apply profile-store mode/owner rules and never authenticate a caller.
use super::*;
use crate::private_fs::{self, CloseRole, Stamp};
use std::{fs::File, os::fd::AsRawFd};

struct Entry {
    path: PathBuf,
    held: Option<File>,
    stamp: Option<Stamp>,
}
pub(in crate::memory) struct Source {
    original: PathBuf,
    parent: Option<File>,
    parent_path: PathBuf,
    parent_stamp: Option<Stamp>,
    entries: Vec<Entry>,
    closed: bool,
    refused: bool,
}
impl Source {
    pub(super) fn capture(path: &Path) -> Result<Self> {
        let original = sqlite_path(path)?;
        let selected = match std::fs::canonicalize(&original) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => original.clone(),
            Err(error) => return Err(error.into()),
        };
        let parent = selected
            .parent()
            .ok_or(MemoryError::ReadinessRecoveryRequired)?;
        let parent_path = parent.canonicalize()?;
        let leaf = selected
            .file_name()
            .ok_or(MemoryError::ReadinessRecoveryRequired)?;
        let selected = parent_path.join(leaf);
        let mut owner = Self {
            original,
            parent: None,
            parent_path,
            parent_stamp: None,
            entries: Vec::new(),
            closed: false,
            refused: false,
        };
        match owner.initialize(&selected) {
            Ok(()) => Ok(owner),
            Err(primary) => finalized(Err(primary), owner.close()),
        }
    }
    fn initialize(&mut self, path: &Path) -> Result<()> {
        self.parent = Some(private_fs::open_at(
            libc::AT_FDCWD,
            self.parent_path.as_os_str(),
            libc::O_PATH | libc::O_DIRECTORY,
            0,
        )?);
        self.parent_stamp = Some(Stamp::from_metadata(
            &self.parent.as_ref().expect("captured parent").metadata()?,
        ));
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let mut name = path.as_os_str().to_os_string();
            name.push(suffix);
            let path = PathBuf::from(name);
            self.entries.push(Entry {
                path,
                held: None,
                stamp: None,
            });
            let entry = self.entries.last_mut().expect("inserted entry");
            match private_fs::open_at(
                libc::AT_FDCWD,
                entry.path.as_os_str(),
                libc::O_PATH | libc::O_NONBLOCK,
                0,
            ) {
                Ok(file) => entry.held = Some(file),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            }
            let metadata = entry.held.as_ref().expect("opened entry").metadata()?;
            if !metadata.is_file() {
                return Err(MemoryError::ReadinessRecoveryRequired);
            }
            entry.stamp = Some(Stamp::from_metadata(&metadata));
        }
        if !self.exists()
            && self
                .entries
                .iter()
                .skip(1)
                .any(|entry| entry.held.is_some())
        {
            return Err(MemoryError::ReadinessRecoveryRequired);
        }
        if self.entries[2].held.is_none()
            && self
                .entries
                .iter()
                .skip(1)
                .any(|entry| entry.held.is_some())
        {
            // A WAL-mode header may make even a read-only connection create
            // an absent WAL. Never hide an existing journal/shm with immutable
            // mode and never create sidecars to inspect an unknown namespace.
            return Err(MemoryError::ReadinessRecoveryRequired);
        }
        self.root_owner_alignment()?;
        self.assert_unchanged()
    }
    fn root_owner_alignment(&self) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        if private_fs::uid() != 0 || !self.exists() {
            return Ok(());
        }
        let main = self.main()?.metadata()?;
        for entry in self.entries.iter().skip(1) {
            let Some(file) = &entry.held else {
                continue;
            };
            let metadata = file.metadata()?;
            // SQLite robustFchown runs even for read-only WAL/journal/shm
            // handles as root. Refuse before SQLite can change ownership
            // or clear set-ID bits on historical sidecars.
            if (metadata.uid(), metadata.gid()) != (main.uid(), main.gid())
                || metadata.mode() & (libc::S_ISUID | libc::S_ISGID) != 0
            {
                return Err(MemoryError::ReadinessRecoveryRequired);
            }
        }
        Ok(())
    }
    pub(super) fn exists(&self) -> bool {
        self.entries
            .first()
            .is_some_and(|entry| entry.held.is_some())
    }
    pub(super) fn preflight_uri(&self) -> Result<String> {
        // Chosen before SQLite opens anything. A finite main-only observation
        // is allowed only with ALL sidecars absent, checked again afterwards.
        // Any existing journal/WAL/shm must be observed by SQLite, never hidden.
        let options = if self
            .entries
            .iter()
            .skip(1)
            .all(|entry| entry.held.is_none())
        {
            "mode=ro&immutable=1"
        } else {
            "mode=ro&readonly_shm=1"
        };
        Ok(format!(
            "file:/proc/self/fd/{}?{options}",
            self.main()?.as_raw_fd()
        ))
    }
    pub(super) fn recall_uri(&self) -> Result<String> {
        // A recall connection must continue observing current transactions;
        // never retain an immutable snapshot across inference or API uses.
        // Ordinary SQLite read marks/IPC are distinct from persisted data.
        Ok(format!(
            "file:/proc/self/fd/{}?mode=ro",
            self.main()?.as_raw_fd()
        ))
    }
    pub(super) fn writer_uri(&self) -> Result<String> {
        Ok(format!(
            "file:/proc/self/fd/{}?mode=rw",
            self.main()?.as_raw_fd()
        ))
    }
    fn main(&self) -> Result<&File> {
        self.entries
            .first()
            .and_then(|entry| entry.held.as_ref())
            .ok_or(MemoryError::ReadinessChanged)
    }
    fn parent_current(&self) -> Result<()> {
        let expected = self
            .parent_stamp
            .as_ref()
            .ok_or(MemoryError::ReadinessChanged)?;
        let held = Stamp::from_metadata(
            &self
                .parent
                .as_ref()
                .ok_or(MemoryError::ReadinessChanged)?
                .metadata()?,
        );
        let named = Stamp::from_metadata(&std::fs::metadata(&self.parent_path)?);
        if !expected.same_inode(&held) || !expected.same_inode(&named) {
            return Err(MemoryError::ReadinessChanged);
        }
        Ok(())
    }
    pub(super) fn assert_unchanged(&self) -> Result<()> {
        self.parent_current()?;
        for entry in &self.entries {
            let named = match std::fs::symlink_metadata(&entry.path) {
                Ok(metadata) => Some(Stamp::from_metadata(&metadata)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            if named != entry.stamp
                || entry
                    .held
                    .as_ref()
                    .map(|file| file.metadata().map(|m| Stamp::from_metadata(&m)))
                    .transpose()?
                    != entry.stamp
            {
                return Err(MemoryError::ReadinessChanged);
            }
        }
        if self.exists() {
            let original = Stamp::from_metadata(&std::fs::metadata(&self.original)?);
            if Some(original) != self.entries[0].stamp {
                return Err(MemoryError::ReadinessChanged);
            }
        }
        Ok(())
    }
    pub(in crate::memory) fn assert_identity(&self, db: &Connection) -> Result<()> {
        self.parent_current()?;
        let main = &self.entries[0];
        let expected = main.stamp.as_ref().ok_or(MemoryError::ReadinessChanged)?;
        for metadata in [
            self.main()?.metadata()?,
            std::fs::metadata(&main.path)?,
            std::fs::metadata(&self.original)?,
        ] {
            if !expected.same_inode(&Stamp::from_metadata(&metadata)) {
                return Err(MemoryError::ReadinessChanged);
            }
        }
        let mut moved = 1;
        db.file_control(Some("main"), rusqlite::FileControl::HasMoved(&mut moved))?;
        if moved != 0 {
            return Err(MemoryError::ReadinessChanged);
        }
        Ok(())
    }
    pub(super) fn create(&mut self) -> Result<()> {
        self.assert_unchanged()?;
        if self.exists() {
            return Err(MemoryError::ReadinessChanged);
        }
        let entry = &mut self.entries[0];
        let leaf = entry
            .path
            .file_name()
            .ok_or(MemoryError::ReadinessChanged)?;
        let parent = self.parent.as_ref().ok_or(MemoryError::ReadinessChanged)?;
        let file = private_fs::open_at(
            parent.as_raw_fd(),
            leaf,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
            0o600,
        )?;
        // Close this ordinary FD before SQLite obtains any byte-range locks.
        // Later retained anchors are O_PATH, which are not ordinary SQLite
        // lock-bearing descriptors.
        let captured = (|| {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            entry.held = Some(private_fs::open_at(
                parent.as_raw_fd(),
                leaf,
                libc::O_PATH,
                0,
            )?);
            let first = Stamp::from_metadata(&file.metadata()?);
            let actual =
                Stamp::from_metadata(&entry.held.as_ref().expect("created anchor").metadata()?);
            if first != actual {
                return Err(MemoryError::ReadinessChanged);
            }
            entry.stamp = Some(first);
            Ok(())
        })();
        finalized(
            captured,
            private_fs::close(file, CloseRole::Data, &entry.path).map_err(Into::into),
        )?;
        self.assert_unchanged()
    }
    pub(in crate::memory) fn refuse(&mut self) {
        self.refused = true;
    }
    pub(in crate::memory) fn close(&mut self) -> Result<()> {
        if self.closed {
            return if self.refused {
                Err(MemoryError::ReadinessUnconfirmed)
            } else {
                Ok(())
            };
        }
        self.closed = true;
        let mut result = Ok(());
        for entry in &mut self.entries {
            if let Some(file) = entry.held.take() {
                result = finalized(
                    result,
                    private_fs::close(file, CloseRole::Data, &entry.path).map_err(Into::into),
                );
            }
        }
        if let Some(file) = self.parent.take() {
            result = finalized(
                result,
                private_fs::close(file, CloseRole::Walk, &self.parent_path).map_err(Into::into),
            );
        }
        self.refused |= result.is_err();
        if result.is_ok() && self.refused {
            Err(MemoryError::ReadinessUnconfirmed)
        } else {
            result
        }
    }
}
