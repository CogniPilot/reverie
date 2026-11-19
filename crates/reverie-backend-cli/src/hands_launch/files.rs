use nix::{
    errno::Errno,
    fcntl::{OFlag, openat, renameat},
    sys::stat::{Mode, mkdirat},
    unistd::{LinkatFlags, UnlinkatFlags, getuid, linkat, unlinkat},
};
use std::{
    fs::{File, Permissions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Component, Path},
};

const PRIVATE: Mode = Mode::S_IRUSR.union(Mode::S_IWUSR);
const INPUT: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_CLOEXEC)
    .union(OFlag::O_NONBLOCK);
const MAX_SETTINGS: u64 = 65_536;

pub(super) struct Directory(File);

fn refused() -> io::Error {
    io::ErrorKind::PermissionDenied.into()
}

impl Directory {
    pub(super) fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(refused());
        }
        let mut directory = File::open("/")?;
        for component in path.components().skip(1) {
            let Component::Normal(name) = component else {
                return Err(refused());
            };
            match mkdirat(&directory, name, Mode::S_IRWXU) {
                Ok(()) | Err(Errno::EEXIST) => {}
                Err(error) => return Err(error.into()),
            }
            let flags = OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_DIRECTORY;
            directory = File::from(openat(&directory, name, flags, Mode::empty())?);
        }
        let directory = File::from(openat(
            &directory,
            ".",
            INPUT | OFlag::O_DIRECTORY,
            Mode::empty(),
        )?);
        if directory.metadata()?.uid() != getuid().as_raw() {
            return Err(refused());
        }
        directory.set_permissions(Permissions::from_mode(0o700))?;
        let directory = Self(directory);
        directory.existing("agent.json")?;
        Ok(directory)
    }

    fn existing(&self, name: &str) -> io::Result<Option<File>> {
        let file = match openat(&self.0, name, INPUT, Mode::empty()) {
            Ok(fd) => File::from(fd),
            Err(Errno::ENOENT) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let info = file.metadata()?;
        if !info.is_file() || info.uid() != getuid().as_raw() {
            return Err(refused());
        }
        Ok(Some(file))
    }

    pub(super) fn read_settings(&self) -> io::Result<Option<Vec<u8>>> {
        let Some(file) = self.existing("runtime-settings.json")? else {
            return Ok(None);
        };
        let info = file.metadata()?;
        if info.mode() & 0o077 != 0 || info.len() > MAX_SETTINGS {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        file.take(MAX_SETTINGS + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_SETTINGS {
            return Err(refused());
        }
        Ok(Some(bytes))
    }

    pub(super) fn publish(&self, name: &str, bytes: &[u8], once: bool) -> io::Result<()> {
        if self.existing(name)?.is_some() && once {
            return Ok(());
        }
        let staged = Stage::new(&self.0, bytes)?;
        if once {
            match linkat(
                &self.0,
                staged.name.as_str(),
                &self.0,
                name,
                LinkatFlags::empty(),
            ) {
                Ok(()) => {}
                Err(Errno::EEXIST) if self.existing(name)?.is_some() => return Ok(()),
                Err(error) => return Err(error.into()),
            }
        } else {
            renameat(&self.0, staged.name.as_str(), &self.0, name)?;
        }
        drop(staged);
        self.0.sync_all()
    }
}

struct Stage<'a> {
    directory: &'a File,
    name: String,
}

impl<'a> Stage<'a> {
    fn new(directory: &'a File, bytes: &[u8]) -> io::Result<Self> {
        let mut nonce = [0; 8];
        getrandom::getrandom(&mut nonce).map_err(|error| io::Error::other(error.to_string()))?;
        let name = format!(".hands-{:016x}.tmp", u64::from_le_bytes(nonce));
        let mut file = File::from(openat(
            directory,
            name.as_str(),
            INPUT | OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL,
            PRIVATE,
        )?);
        let staged = Self { directory, name };
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(staged)
    }
}

impl Drop for Stage<'_> {
    fn drop(&mut self) {
        let _ = unlinkat(
            self.directory,
            self.name.as_str(),
            UnlinkatFlags::NoRemoveDir,
        );
    }
}
