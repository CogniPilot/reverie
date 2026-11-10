//! Preserve the actual old inode before one cooperative atomic request CAS.
//! Unknown link/rename/fsync/close never removes evidence or authorizes retry.
use super::*;
use std::{ffi::OsStr, os::unix::fs::DirBuilderExt};
pub(super) struct Publication {
    original: Option<File>,
    before: Option<fs::Metadata>,
    history: PathBuf,
    history_fd: Option<File>,
    history_root_fd: Option<File>,
    history_root_stamp: Option<native::private_goal::PathIdentity>,
    history_stamp: Option<native::private_goal::PathIdentity>,
    archive: PathBuf,
    temporary: String,
    writer: Option<File>,
    new_stamp: Option<native::PrivateFileStamp>,
    archived: bool,
    published: bool,
}
impl Publication {
    pub(super) fn history_path(&self) -> &Path {
        &self.history
    }
    pub(super) fn history_fd(&self) -> &File {
        self.history_fd
            .as_ref()
            .expect("original history directory")
    }
    pub(super) fn assert_history_bound(&self, owner: &NominationOwner) -> Result<()> {
        self.assert_history_current(owner)
    }
    pub(super) fn empty() -> Self {
        Self {
            original: None,
            before: None,
            history: PathBuf::new(),
            history_fd: None,
            history_root_fd: None,
            history_root_stamp: None,
            history_stamp: None,
            archive: PathBuf::new(),
            temporary: String::new(),
            writer: None,
            new_stamp: None,
            archived: false,
            published: false,
        }
    }
    pub(super) fn capture(&mut self, owner: &NominationOwner) -> Result<()> {
        let parent = owner.directories.as_ref().expect("fixed parent");
        self.original = Some(native::open_policy_original(
            &parent.directories[1],
            OsStr::new("registration-request.json"),
        )?);
        let before = self
            .original
            .as_ref()
            .expect("retained original")
            .metadata()?;
        need(
            owner.input_stamp.as_ref() == Some(&Fingerprint::of(&before)),
            "POOL_NOMINATION_FILE_CHANGED",
        )?;
        self.before = Some(before);
        let history_root = parent.root.join("worker-pool/nomination-history");
        match fs::DirBuilder::new().mode(0o700).create(&history_root) {
            Ok(()) => parent.directories[1].sync_all()?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.into()),
        }
        private_directory(&history_root)?;
        self.history_root_fd = Some(native::open_at(
            nix::libc::AT_FDCWD,
            history_root.as_os_str(),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?);
        self.history_root_stamp = Some(native::private_goal::identity(
            &self
                .history_root_fd
                .as_ref()
                .expect("original history root")
                .metadata()?,
        ));
        let nonce = crate::resource_facts::fresh_owner_nonce()?;
        self.history = history_root.join(nonce.as_str());
        fs::DirBuilder::new().mode(0o700).create(&self.history)?;
        self.history_fd = Some(native::open_at(
            nix::libc::AT_FDCWD,
            self.history.as_os_str(),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?);
        private_directory(&self.history)?;
        self.history_stamp = Some(native::private_goal::identity(
            &self
                .history_fd
                .as_ref()
                .expect("retained history")
                .metadata()?,
        ));
        self.archive = self.history.join("request-before.json");
        self.temporary = format!("registration-request.next-{}", nonce.as_str());
        Ok(())
    }
    pub(super) fn publish(
        &mut self,
        owner: &NominationOwner,
        next: &PoolInstallationRequestData,
        locks: &mut ImageMaintenanceLocks,
        service: &ImageServiceMaintenance,
    ) -> Result<()> {
        need(
            !self.archived && !self.published,
            "POOL_NOMINATION_REVISION_ALREADY_ATTEMPTED",
        )?;
        let directory = &owner.directories.as_ref().expect("same parent").directories[1];
        self.writer = Some(native::create_policy_temporary(
            directory,
            OsStr::new(&self.temporary),
        )?);
        let writer = self.writer.as_mut().expect("retained before write");
        writer.set_permissions(fs::Permissions::from_mode(0o600))?;
        writer.write_all(next.canonical_bytes())?;
        writer.sync_all()?;
        let info = writer.metadata()?;
        private_file(&info, 1)?;
        self.new_stamp = Some(native::PrivateFileStamp::of(&info));
        directory.sync_all()?;
        self.assert_old(owner, 1)?;
        fence(owner, locks, service)?;
        self.assert_history_current(owner)?;
        self.archived = true;
        fs::hard_link(&owner.selection, &self.archive)?;
        self.assert_old(owner, 2)?;
        self.history_fd
            .as_ref()
            .expect("original history")
            .sync_all()?;
        self.history_root_fd
            .as_ref()
            .expect("retained history parent")
            .sync_all()?;
        directory.sync_all()?;
        fence(owner, locks, service)?;
        self.assert_history_current(owner)?;
        self.assert_old(owner, 2)?;
        let temp = PathBuf::from(format!(
            "/proc/self/fd/{}/{}",
            directory.as_raw_fd(),
            self.temporary
        ));
        need(
            self.new_stamp.as_ref()
                == Some(&native::PrivateFileStamp::of(&fs::symlink_metadata(temp)?)),
            "POOL_NOMINATION_TEMPORARY_CHANGED",
        )?;
        need(
            self.new_stamp.as_ref()
                == Some(&native::PrivateFileStamp::of(
                    &self
                        .writer
                        .as_ref()
                        .expect("retained new inode")
                        .metadata()?,
                )),
            "POOL_NOMINATION_TEMPORARY_CHANGED",
        )?;
        self.published = true;
        native::replace_policy(
            directory,
            OsStr::new(&self.temporary),
            OsStr::new("registration-request.json"),
        )?;
        directory.sync_all()?;
        self.history_fd.as_ref().expect("same history").sync_all()?;
        self.assert_published(owner, next)
    }
    fn assert_old(&self, owner: &NominationOwner, links: u64) -> Result<()> {
        let named = fs::symlink_metadata(&owner.selection)?;
        let held = self.original.as_ref().expect("original inode").metadata()?;
        let before = self.before.as_ref().expect("original metadata");
        same_inode(before, &held, links)?;
        need(
            native::PrivateFileStamp::of(&named) == native::PrivateFileStamp::of(&held),
            "POOL_NOMINATION_FILE_CHANGED",
        )?;
        if self.archived {
            need(
                native::PrivateFileStamp::of(&fs::symlink_metadata(&self.archive)?)
                    == native::PrivateFileStamp::of(&held),
                "POOL_NOMINATION_ARCHIVE_CHANGED",
            )?;
        }
        let size = usize::try_from(before.len())
            .map_err(|_| PoolNominationError::Refused("POOL_NOMINATION_INPUT_BOUND"))?;
        need(size <= 65536, "POOL_NOMINATION_INPUT_BOUND")?;
        let mut raw = vec![0; size];
        std::os::unix::fs::FileExt::read_exact_at(
            self.original.as_ref().expect("same original"),
            &mut raw,
            0,
        )?;
        need(
            owner.raw.as_ref() == Some(&raw),
            "POOL_NOMINATION_ARCHIVE_CHANGED",
        )
    }
    pub(super) fn assert_published(
        &self,
        owner: &NominationOwner,
        next: &PoolInstallationRequestData,
    ) -> Result<()> {
        need(
            self.published && self.archived,
            "POOL_NOMINATION_REVISION_UNCONFIRMED",
        )?;
        self.assert_history_current(owner)?;
        let before = self.before.as_ref().expect("original metadata");
        same_inode(before, &fs::symlink_metadata(&self.archive)?, 1)?;
        let info = fs::symlink_metadata(&owner.selection)?;
        private_file(&info, 1)?;
        need(
            native::PrivateFileStamp::of(&info)
                .same_renamed_file(self.new_stamp.as_ref().expect("same new inode")),
            "POOL_NOMINATION_OUTPUT_CHANGED",
        )?;
        if let Some(writer) = &self.writer {
            need(
                native::PrivateFileStamp::of(&writer.metadata()?)
                    == native::PrivateFileStamp::of(&info),
                "POOL_NOMINATION_OUTPUT_CHANGED",
            )?;
        }
        let raw = native::observe(&owner.selection, 65536, |m| {
            native::PrivateFileStamp::of(m) == native::PrivateFileStamp::of(&info)
        })?;
        need(
            raw == next.canonical_bytes(),
            "POOL_NOMINATION_OUTPUT_CHANGED",
        )?;
        let archive = native::observe(&self.archive, 65536, |m| same_inode(before, m, 1).is_ok())?;
        need(
            owner.raw.as_ref() == Some(&archive),
            "POOL_NOMINATION_ARCHIVE_CHANGED",
        )
    }
    fn close_writer(&mut self) -> Result<()> {
        self.writer
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into))
    }
    fn assert_history_current(&self, owner: &NominationOwner) -> Result<()> {
        let directories = owner.directories.as_ref().expect("original request parent");
        for (index, (path, original)) in owner.directory_identities.iter().enumerate() {
            private_directory(path)?;
            let named = native::private_goal::identity(&fs::symlink_metadata(path)?);
            need(&named == original, "POOL_NOMINATION_DIRECTORY_CHANGED")?;
            if let Some(held) = directories.directories.get(index) {
                need(
                    native::private_goal::identity(&held.metadata()?) == named,
                    "POOL_NOMINATION_DIRECTORY_CHANGED",
                )?;
            }
        }
        for (path, stamp, held) in [
            (
                self.history.parent().expect("fixed history root"),
                self.history_root_stamp.as_ref(),
                self.history_root_fd.as_ref(),
            ),
            (
                self.history.as_path(),
                self.history_stamp.as_ref(),
                self.history_fd.as_ref(),
            ),
        ] {
            private_directory(path)?;
            let named = native::private_goal::identity(&fs::symlink_metadata(path)?);
            need(Some(&named) == stamp, "POOL_NOMINATION_ARCHIVE_CHANGED")?;
            if let Some(held) = held {
                need(
                    native::private_goal::identity(&held.metadata()?) == named,
                    "POOL_NOMINATION_ARCHIVE_CHANGED",
                )?;
            }
        }
        Ok(())
    }
    pub(super) fn close(&mut self) -> Result<()> {
        let writer = self.close_writer();
        let old = self
            .original
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into));
        let history = self
            .history_fd
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into));
        let parent = self
            .history_root_fd
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into));
        finalized(finalized(writer, old), finalized(history, parent))
    }
}
fn private_file(info: &fs::Metadata, links: u64) -> Result<()> {
    need(
        info.is_file()
            && info.uid() == native::uid()
            && info.gid() == nix::unistd::getegid().as_raw()
            && info.mode() & 0o7777 == 0o600
            && info.nlink() == links,
        "POOL_NOMINATION_PRIVATE_FILE",
    )
}
fn same_inode(before: &fs::Metadata, after: &fs::Metadata, links: u64) -> Result<()> {
    private_file(after, links)?;
    need(
        before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec(),
        "POOL_NOMINATION_ARCHIVE_CHANGED",
    )
}
fn private_directory(path: &Path) -> Result<()> {
    let info = fs::symlink_metadata(path)?;
    need(
        info.is_dir()
            && info.uid() == native::uid()
            && info.gid() == nix::unistd::getegid().as_raw()
            && info.mode() & 0o7777 == 0o700,
        "POOL_NOMINATION_HISTORY_CUSTODY",
    )
}
pub(super) fn fence(
    owner: &NominationOwner,
    locks: &mut ImageMaintenanceLocks,
    service: &ImageServiceMaintenance,
) -> Result<()> {
    owner.current()?;
    owner.assert_source()?;
    locks.assert_held_current()?;
    service.assert_publication_current(owner.source.as_ref().expect("same source"))?;
    Ok(())
}
