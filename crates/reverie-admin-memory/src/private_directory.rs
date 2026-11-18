use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
    unistd::getuid,
};
use std::{
    fs::File,
    io,
    os::unix::fs::MetadataExt,
    path::{Component, Path},
};

pub(crate) fn open_private_directory(path: &Path) -> io::Result<File> {
    if !path.is_absolute() {
        return Err(crate::refused());
    }
    let flags = OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let mut directory = open(Path::new("/"), flags, Mode::empty())?;
    for component in path.components() {
        directory = match component {
            Component::RootDir => continue,
            Component::Normal(name) => openat(&directory, name, flags, Mode::empty())?,
            _ => return Err(crate::refused()),
        };
    }
    let directory = File::from(directory);
    let info = directory.metadata()?;
    if info.uid() != getuid().as_raw() || info.mode() & 0o077 != 0 {
        return Err(crate::refused());
    }
    Ok(directory)
}
