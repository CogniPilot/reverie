//! Read an attachment only inside the selected shared room directory.
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::Mode,
};
use std::{
    fs::File,
    io::{self, Read},
    path::{Component, Path},
};

fn outside_room() -> io::Error {
    io::Error::other("outside the room attachments directory")
}

pub(super) fn read(root: &Path, room: &str, source: &Path, max_bytes: u64) -> io::Result<Vec<u8>> {
    let mut components = Path::new(room).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(outside_room());
    }
    let room = root.canonicalize()?.join(room);
    let source = source.canonicalize()?;
    let relative = source.strip_prefix(&room).map_err(|_| outside_room())?;
    let name = relative.file_name().ok_or_else(outside_room)?;
    let directory = crate::private_directory::open_absolute_directory(
        &room.join(relative.parent().ok_or_else(outside_room)?),
    )?;
    let access = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
    let file = File::from(openat(&directory, name, access, Mode::empty())?);
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("not a regular room attachment"));
    }
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}
