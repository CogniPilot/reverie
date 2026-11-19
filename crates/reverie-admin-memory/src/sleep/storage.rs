use super::Result;
use std::{
    fs::{self, File, OpenOptions, Permissions},
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};

pub(super) fn regular(path: &Path, append: bool) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(!append)
        .append(append)
        .create(append)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("expected a regular sleep file"));
    }
    Ok(file)
}

pub(super) fn read_snapshot(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("expected a regular sleep input"));
    }
    Ok(file)
}

pub(super) fn replace(
    path: &Path,
    mode: u32,
    write: impl FnOnce(&mut File) -> Result<()>,
) -> Result<()> {
    replace_checked(path, mode, write, |()| Ok(()))
}

pub(super) fn replace_checked<T>(
    path: &Path,
    mode: u32,
    write: impl FnOnce(&mut File) -> Result<T>,
    check: impl FnOnce(T) -> Result<()>,
) -> Result<()> {
    let parent = path.parent().ok_or("sleep path has no parent")?;
    let (file, temporary) = nix::unistd::mkstemp(&parent.join(".sleep-write-XXXXXX"))?;
    let mut file = File::from(file);
    let result = (|| -> Result<()> {
        let observation = write(&mut file)?;
        file.flush()?;
        file.set_permissions(Permissions::from_mode(mode))?;
        file.sync_all()?;
        check(observation)?;
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn create_state(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}
