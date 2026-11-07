//! Fixed resolver-selected temporary directories and managed owner-text update.
//! No path argument or execution/authorization permit is accepted or returned.
use super::*;
use nix::{
    fcntl::renameat,
    sys::stat::{Mode, mkdirat},
};
use std::{
    ffi::OsStr,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt},
    },
};
pub(super) fn path_text(
    config: &Configuration,
    paths: &StoragePaths,
) -> Result<reverie_contracts::reservation_engine::StoragePathText> {
    use reverie_contracts::reservation_engine::StorageIdentityRef;
    let identity = paths.employee().map_or_else(
        || StorageIdentityRef::Session(paths.session()),
        StorageIdentityRef::Employee,
    );
    config
        .data
        .storage_path_text(identity)
        .map_err(StorageError::PathText)
}

fn close_all(mut files: Vec<File>, mut result: Result<PathBuf>) -> Result<PathBuf> {
    while let Some(file) = files.pop() {
        result = finalized(result, fs::close(file));
    }
    result
}
fn mkdir_parents(path: &Path, mode: u32, effects: &mut bool) -> Result<()> {
    match std::fs::DirBuilder::new().mode(mode).create(path) {
        Ok(()) => {
            *effects = true;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent().filter(|parent| *parent != path) {
                mkdir_parents(parent, 0o777, effects)?;
            }
            match std::fs::DirBuilder::new().mode(mode).create(path) {
                Ok(()) => {
                    *effects = true;
                    Ok(())
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() =>
                {
                    Ok(())
                }
                Err(error) => Err(error.into()),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
        Err(error) => Err(error.into()),
    }
}
pub(super) fn private(file: &File, uid: u32) -> Result<()> {
    let info = file.metadata()?;
    need(
        info.is_dir() && info.uid() == uid && info.mode() & 0o077 == 0,
        StorageFault::PrivateDirectory,
    )
}
pub(super) fn temporary(
    config: &Configuration,
    paths: &StoragePaths,
    effects: &mut bool,
) -> Result<PathBuf> {
    let root = config.scratch()?;
    let scratch = paths.scratch();
    let original = path_text(config, paths)?;
    need(
        native::python_path(&original.scratch().codepoints())? == scratch,
        StorageFault::TemporaryChanged,
    )?;
    let parts = scratch
        .strip_prefix(&root)
        .map_err(|_| StorageError::Refused(StorageFault::TemporaryIdentity))?
        .components()
        .map(|part| part.as_os_str().to_owned())
        .collect::<Vec<_>>();
    let identity = match parts.as_slice() {
        [identity] => identity
            .to_str()
            .is_some_and(|v| ProfileSessionId::parse(v).is_ok()),
        [employees, identity] if employees == "employees" => identity
            .to_str()
            .is_some_and(|v| reverie_core::ids::ProfileEmployeeId::parse(v).is_ok()),
        _ => false,
    };
    need(identity, StorageFault::TemporaryIdentity)?;
    mkdir_parents(&root, 0o700, effects)?;
    let mut files = vec![native::open_at(
        libc::AT_FDCWD,
        root.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?];
    let result = (|| {
        private(files.last().expect("root"), config.uid())?;
        for part in parts
            .iter()
            .map(OsString::as_os_str)
            .chain(std::iter::once(OsStr::new("tmp")))
        {
            let parent = files.last().expect("owned parent");
            match mkdirat(parent, part, Mode::S_IRWXU) {
                Ok(()) => *effects = true,
                Err(nix::errno::Errno::EEXIST) => {}
                Err(error) => return Err(std::io::Error::from(error).into()),
            }
            let child =
                native::open_at(parent.as_raw_fd(), part, libc::O_RDONLY | libc::O_DIRECTORY)?;
            files.push(child);
            private(files.last().expect("owned child"), config.uid())?;
        }
        let target = scratch.join("tmp");
        let named = std::fs::symlink_metadata(&target)?;
        let held = files.last().expect("tmp").metadata()?;
        let lexical = original.scratch().join(&PosixPath::from_scalar_text("tmp"));
        need(
            native::resolve_strict_text(&lexical.codepoints())? == lexical
                && named.dev() == held.dev()
                && named.ino() == held.ino(),
            StorageFault::TemporaryChanged,
        )?;
        Ok(target)
    })();
    close_all(files, result)
}
impl StorageLease {
    pub fn prepare_temporary(&mut self) -> Result<PathBuf> {
        self.assert_current()?;
        let mut effects = false;
        let result = temporary(&self.config, &self.paths, &mut effects);
        partial(finalized(result, self.assert_current()), effects)
    }
    pub fn home_workspace_alias(&mut self) -> Result<()> {
        self.assert_current()?;
        if !self.config.data.has_shared_workspace()? {
            return Ok(());
        }
        let result = workspace_alias(&self.paths);
        partial(finalized(result, self.assert_current()), true)
    }
    pub fn write_storage_instructions(&mut self) -> Result<()> {
        self.assert_current()?;
        let mut effects = false;
        let original = path_text(&self.config, &self.paths)?;
        let result = instructions(self.paths.home(), original.home(), &mut effects);
        partial(finalized(result, self.assert_current()), effects)
    }
}
pub(super) fn workspace_alias(paths: &StoragePaths) -> Result<()> {
    match std::os::unix::fs::symlink("/reverie_workspace", paths.home().join("workspace")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn signature(info: &std::fs::Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    (
        info.dev(),
        info.ino(),
        info.size(),
        info.mtime(),
        info.mtime_nsec(),
        info.ctime(),
        info.ctime_nsec(),
    )
}
pub(super) fn instructions(home: &Path, original: &PosixPath, effects: &mut bool) -> Result<()> {
    // Keep Python text provenance through the existing shared path resolver.
    let text = original.codepoints();
    need(
        native::python_path(&text)? == home && native::resolve_optional_text(&text)? == *original,
        StorageFault::CanonicalPath,
    )?;
    let directory = native::open_at(
        libc::AT_FDCWD,
        home.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    let temporary =
        reverie_store::worker_storage::instruction_temporary_name().map_err(StorageError::Entropy);
    let name = match temporary {
        Ok(value) => value,
        Err(error) => return finalized(Err(error), fs::close(directory)),
    };
    publish_and_close(home, directory, name, effects)
}
struct InstructionTemporary {
    name: String,
    identity: Option<(u64, u64)>,
    held: Option<File>,
}
fn publish_and_close(home: &Path, directory: File, name: String, effects: &mut bool) -> Result<()> {
    let mut temporary = InstructionTemporary {
        name,
        identity: None,
        held: None,
    };
    let result = publish_instructions(home, &directory, &mut temporary, effects);
    let closed = temporary.held.take().map_or(Ok(()), fs::close);
    // There is no conditional-unlink syscall. A previous inode check cannot
    // authorize removing this name after another worker replaces it. Failed
    // attempts retain their temporary evidence; successful rename consumes our
    // name and needs no cleanup. Close only the descriptors we actually own.
    finalized(finalized(result, closed), fs::close(directory))
}
fn temporary_current(directory: &File, temporary: &InstructionTemporary) -> Result<bool> {
    let identity = temporary
        .identity
        .ok_or(StorageError::Refused(StorageFault::InstructionChanged))?;
    let held = temporary
        .held
        .as_ref()
        .ok_or(StorageError::Refused(StorageFault::InstructionChanged))?
        .metadata()?;
    need(
        (held.dev(), held.ino()) == identity,
        StorageFault::InstructionChanged,
    )?;
    match nix::sys::stat::fstatat(
        directory,
        temporary.name.as_str(),
        nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW,
    ) {
        Ok(info) => {
            need(
                (info.st_dev, info.st_ino) == identity,
                StorageFault::InstructionChanged,
            )?;
            Ok(true)
        }
        Err(nix::errno::Errno::ENOENT) => Ok(false),
        Err(error) => Err(std::io::Error::from(error).into()),
    }
}
#[cfg(test)]
pub(super) fn instruction_collision_for_owned_test(home: &Path, name: String) -> Result<()> {
    let directory = native::open_at(
        libc::AT_FDCWD,
        home.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    publish_and_close(home, directory, name, &mut false)
}
fn prior(directory: &File) -> Result<(Option<std::fs::Metadata>, Vec<u8>)> {
    let opened = native::open_at(
        directory.as_raw_fd(),
        OsStr::new("AGENTS.md"),
        libc::O_RDONLY | libc::O_NONBLOCK,
    );
    let mut file = match opened {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((None, Vec::new()));
        }
        Err(error) => return Err(error.into()),
    };
    let result = (|| {
        let info = file.metadata()?;
        need(
            info.is_file() && info.uid() == native::uid() && info.nlink() == 1,
            StorageFault::InstructionCustody,
        )?;
        let mut bytes = Vec::new();
        (&mut file).take(65537).read_to_end(&mut bytes)?;
        Ok((Some(info), bytes))
    })();
    finalized(result, fs::close(file))
}
fn publish_instructions(
    home: &Path,
    directory: &File,
    temporary: &mut InstructionTemporary,
    effects: &mut bool,
) -> Result<()> {
    let parent = directory.metadata()?;
    need(
        parent.uid() == native::uid() && parent.mode() & 0o077 == 0,
        StorageFault::InstructionCustody,
    )?;
    let (before, raw) = prior(directory)?;
    let bytes = reverie_contracts::worker_storage::storage_instruction_bytes(&raw)
        .map_err(StorageError::Instructions)?;
    *effects = true;
    let mut output = native::open_at_mode(
        directory.as_raw_fd(),
        OsStr::new(&temporary.name),
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )?;
    let write = (|| {
        let created = output.metadata()?;
        temporary.identity = Some((created.dev(), created.ino()));
        let held = native::open_at(
            directory.as_raw_fd(),
            OsStr::new(&temporary.name),
            libc::O_PATH,
        )?;
        let checked = held.metadata().map_err(Into::into).and_then(|info| {
            need(
                (info.dev(), info.ino()) == (created.dev(), created.ino()),
                StorageFault::InstructionChanged,
            )
        });
        if let Err(error) = checked {
            return finalized(Err(error), fs::close(held));
        }
        temporary.held = Some(held);
        output.write_all(&bytes)?;
        output.sync_all()?;
        Ok(())
    })();
    finalized(write, fs::close(output))?;
    #[cfg(test)]
    super::tests::publication_written(home)?;
    let named = nix::sys::stat::fstatat(
        directory,
        "AGENTS.md",
        nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW,
    );
    let named = match named {
        Ok(value) => Some(value),
        Err(nix::errno::Errno::ENOENT) => None,
        Err(error) => return Err(std::io::Error::from(error).into()),
    };
    let unchanged = match (&before, &named) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            signature(left)
                == (
                    right.st_dev,
                    right.st_ino,
                    right.st_size as u64,
                    right.st_mtime,
                    right.st_mtime_nsec,
                    right.st_ctime,
                    right.st_ctime_nsec,
                )
        }
        _ => false,
    };
    let current = std::fs::symlink_metadata(home)?;
    need(
        unchanged && current.dev() == parent.dev() && current.ino() == parent.ino(),
        StorageFault::InstructionChanged,
    )?;
    need(
        temporary_current(directory, temporary)?,
        StorageFault::InstructionChanged,
    )?;
    renameat(directory, temporary.name.as_str(), directory, "AGENTS.md")
        .map_err(std::io::Error::from)?;
    directory.sync_all()?;
    Ok(())
}
