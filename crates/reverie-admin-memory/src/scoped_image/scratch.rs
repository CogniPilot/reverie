use super::refused;
use nix::{
    errno::Errno,
    fcntl::{OFlag, openat},
    sys::stat::{Mode, mkdirat},
    unistd::{UnlinkatFlags, getuid, mkdtemp, unlinkat},
};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

pub(super) const BASENAME: &str = "image.bin";
const DIRECTORY: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_CLOEXEC)
    .union(OFlag::O_DIRECTORY)
    .union(OFlag::O_NOFOLLOW);

pub(super) struct ImageScratch {
    directory: File,
    temporary: Temporary,
}

struct Temporary {
    path: PathBuf,
    _root: File,
    identity: (u64, u64),
}

impl Temporary {
    fn clean(&self) -> io::Result<()> {
        let named = self.path.symlink_metadata()?;
        if !named.is_dir() || identity(&named) != self.identity {
            return Err(refused());
        }
        fs::remove_dir(&self.path)
    }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = self.clean();
    }
}

fn open_root(path: &Path) -> io::Result<File> {
    let parent = path.parent().ok_or_else(refused)?;
    let name = path.file_name().ok_or_else(refused)?;
    if parent.canonicalize()?.as_os_str() != parent.as_os_str() {
        return Err(refused());
    }
    let parent = OpenOptions::new()
        .read(true)
        .custom_flags(DIRECTORY.bits())
        .open(parent)?;
    match mkdirat(&parent, name, Mode::S_IRWXU) {
        Ok(()) | Err(Errno::EEXIST) => {}
        Err(error) => return Err(error.into()),
    }
    let root = File::from(openat(&parent, name, DIRECTORY, Mode::empty())?);
    let named = path.symlink_metadata()?;
    let opened = root.metadata()?;
    if !named.is_dir()
        || opened.uid() != getuid().as_raw()
        || identity(&named) != identity(&opened)
        || path.canonicalize()?.as_os_str() != path.as_os_str()
    {
        return Err(refused());
    }
    Ok(root)
}

fn identity(info: &Metadata) -> (u64, u64) {
    (info.dev(), info.ino())
}

impl ImageScratch {
    pub(super) fn new(root: &Path) -> io::Result<Self> {
        let root = open_root(root)?;
        let template = PathBuf::from(format!("/proc/self/fd/{}", root.as_raw_fd()))
            .join("reverie-image-XXXXXX");
        let path = mkdtemp(&template)?;
        let metadata = path.symlink_metadata()?;
        let temporary = Temporary {
            path,
            _root: root,
            identity: identity(&metadata),
        };
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(DIRECTORY.bits())
            .open(&temporary.path)?;
        let opened = directory.metadata()?;
        if identity(&opened) != temporary.identity
            || opened.uid() != getuid().as_raw()
            || opened.mode() & 0o077 != 0
        {
            return Err(refused());
        }
        Ok(Self {
            directory,
            temporary,
        })
    }

    pub(super) fn cwd(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd()))
    }

    pub(super) fn clean(self) -> io::Result<()> {
        self.remove_image()?;
        self.temporary.clean()
    }

    fn remove_image(&self) -> io::Result<()> {
        match unlinkat(&self.directory, BASENAME, UnlinkatFlags::NoRemoveDir) {
            Ok(()) | Err(Errno::ENOENT) => Ok(()),
            Err(Errno::EISDIR) => {
                unlinkat(&self.directory, BASENAME, UnlinkatFlags::RemoveDir).map_err(Into::into)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub(super) fn read(&self, max_bytes: u64) -> io::Result<Vec<u8>> {
        let flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK;
        let mut file = File::from(openat(&self.directory, BASENAME, flags, Mode::empty())?);
        let before = file.metadata()?;
        if !before.is_file()
            || before.uid() != getuid().as_raw()
            || before.nlink() != 1
            || before.mode() & 0o7777 != 0o600
            || before.len() > max_bytes
        {
            return Err(refused());
        }
        let mut data = Vec::new();
        (&mut file).take(max_bytes + 1).read_to_end(&mut data)?;
        if data.len() as u64 != before.len()
            || data.len() as u64 > max_bytes
            || !unchanged(&before, &file.metadata()?)
        {
            return Err(refused());
        }
        Ok(data)
    }
}

impl Drop for ImageScratch {
    fn drop(&mut self) {
        let _ = self.remove_image();
    }
}

fn unchanged(before: &Metadata, after: &Metadata) -> bool {
    identity(before) == identity(after)
        && before.mode() == after.mode()
        && before.uid() == after.uid()
        && before.gid() == after.gid()
        && before.nlink() == after.nlink()
        && before.len() == after.len()
        && (before.mtime(), before.mtime_nsec()) == (after.mtime(), after.mtime_nsec())
        && (before.ctime(), before.ctime_nsec()) == (after.ctime(), after.ctime_nsec())
}
