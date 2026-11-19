//! Publish and remove a single telemetry leaf through a held directory.
use nix::{
    errno::Errno,
    fcntl::{OFlag, open, openat, renameat},
    sys::stat::{Mode, mkdirat},
    unistd::{UnlinkatFlags, geteuid, unlinkat},
};
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::{self, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Component, Path},
};

const DIRECTORY: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_DIRECTORY)
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_CLOEXEC);

pub(super) struct Destination {
    parts: Vec<OsString>,
    leaf: OsString,
}

impl Destination {
    pub(super) fn new(path: &Path) -> io::Result<Self> {
        let leaf = path
            .file_name()
            .ok_or(io::ErrorKind::InvalidInput)?
            .to_owned();
        let parts = absolute_parts(path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
        if parts.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "GPU telemetry requires a private output directory",
            ));
        }
        Ok(Self { parts, leaf })
    }

    fn directory(&self, create: bool) -> io::Result<File> {
        let mut directory = File::from(open("/", DIRECTORY, Mode::empty())?);
        for part in &self.parts {
            directory = child_directory(&directory, part, create)?;
        }
        check_private(&directory)?;
        Ok(directory)
    }

    pub(super) fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let directory = self.directory(true)?;
        let temporary = Temporary::new(&directory, &self.leaf)?;
        let mut file = File::from(openat(
            &directory,
            temporary.leaf.as_os_str(),
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::S_IRUSR | Mode::S_IWUSR,
        )?);
        // Only an exclusively created temporary may be removed on failure.
        let mut temporary = temporary;
        temporary.owned = true;
        file.write_all(bytes)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o644))?;
        file.sync_all()?;
        renameat(
            &directory,
            temporary.leaf.as_os_str(),
            &directory,
            self.leaf.as_os_str(),
        )?;
        temporary.owned = false;
        directory.sync_all()
    }

    pub(super) fn clear(&self) -> io::Result<()> {
        match self.directory(false) {
            Ok(directory) => match unlinkat(
                &directory,
                self.leaf.as_os_str(),
                UnlinkatFlags::NoRemoveDir,
            ) {
                Ok(()) | Err(Errno::ENOENT) => Ok(()),
                Err(error) => Err(error.into()),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

fn child_directory(parent: &File, part: &OsStr, create: bool) -> io::Result<File> {
    match openat(parent, part, DIRECTORY, Mode::empty()) {
        Err(Errno::ENOENT) if create => {
            match mkdirat(parent, part, Mode::S_IRWXU) {
                Ok(()) | Err(Errno::EEXIST) => {}
                Err(error) => return Err(error.into()),
            }
            Ok(File::from(openat(parent, part, DIRECTORY, Mode::empty())?))
        }
        result => Ok(File::from(result?)),
    }
}

fn check_private(directory: &File) -> io::Result<()> {
    let metadata = directory.metadata()?;
    if metadata.uid() != geteuid().as_raw() || metadata.mode() & 0o022 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "GPU telemetry directory is shared or foreign",
        ));
    }
    Ok(())
}

fn temporary_prefix(leaf: &OsStr) -> OsString {
    let mut prefix = OsString::from(".");
    prefix.push(leaf);
    prefix.push(".");
    prefix
}

struct Temporary<'a> {
    directory: &'a File,
    leaf: OsString,
    owned: bool,
}

impl<'a> Temporary<'a> {
    fn new(directory: &'a File, leaf: &OsStr) -> io::Result<Self> {
        let mut random = [0; 8];
        getrandom::getrandom(&mut random).map_err(|error| io::Error::other(error.to_string()))?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let mut leaf = temporary_prefix(leaf);
        leaf.push(suffix);
        Ok(Self {
            directory,
            leaf,
            owned: false,
        })
    }
}

impl Drop for Temporary<'_> {
    fn drop(&mut self) {
        if self.owned {
            let _ = unlinkat(
                self.directory,
                self.leaf.as_os_str(),
                UnlinkatFlags::NoRemoveDir,
            );
        }
    }
}

fn absolute_parts(path: &Path) -> io::Result<Vec<OsString>> {
    let mut parts = Vec::new();
    for component in std::path::absolute(path)?.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_owned()),
            Component::ParentDir => {
                parts.pop();
            }
            _ => {}
        }
    }
    Ok(parts)
}
