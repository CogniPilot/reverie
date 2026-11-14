use super::{Failure, Home, Result, join};
use nix::{
    fcntl::{AtFlags, OFlag, open, openat},
    sys::stat::{FileStat, Mode, SFlag, fstat, fstatat, mkdirat},
    unistd::{UnlinkatFlags, close, geteuid, linkat, unlinkat},
};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
const DIRECTORY: &str = ".reverie";
const PENDING: &str = "docker-worker-identity.pending";
const FINAL: &str = "docker-worker-identity";
const DIRECTORY_FLAGS: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_DIRECTORY)
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_CLOEXEC);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    dev: u64,
    ino: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    nlink: u64,
    size: i64,
    mtime: i64,
    mtimen: i64,
    ctime: i64,
    ctimen: i64,
}
impl From<FileStat> for Stamp {
    fn from(s: FileStat) -> Self {
        Self {
            dev: s.st_dev,
            ino: s.st_ino,
            uid: s.st_uid,
            gid: s.st_gid,
            mode: s.st_mode,
            nlink: s.st_nlink,
            size: s.st_size,
            mtime: s.st_mtime,
            mtimen: s.st_mtime_nsec,
            ctime: s.st_ctime,
            ctimen: s.st_ctime_nsec,
        }
    }
}
impl Stamp {
    fn identity(self, other: Self) -> bool {
        self.dev == other.dev
            && self.ino == other.ino
            && self.uid == other.uid
            && self.gid == other.gid
            && self.mode == other.mode
    }
    fn home(self) -> Home {
        Home {
            dev: self.dev,
            ino: self.ino,
        }
    }
    fn directory(self, uid: u32, mode: u32) -> bool {
        SFlag::from_bits_truncate(self.mode) == SFlag::S_IFDIR
            && self.uid == uid
            && self.mode & 0o7777 == mode
    }
}
fn fd(file: &File) -> Result<Stamp> {
    fstat(file)
        .map(Stamp::from)
        .map_err(|error| Failure::new("fd-stat", error))
}
fn named(directory: &File, name: &str) -> Result<Stamp> {
    fstatat(directory, name, AtFlags::AT_SYMLINK_NOFOLLOW)
        .map(Stamp::from)
        .map_err(|error| Failure::new("named-stat", error))
}
fn absent(directory: &File, name: &str) -> Result<bool> {
    match fstatat(directory, name, AtFlags::AT_SYMLINK_NOFOLLOW) {
        Ok(_) => Ok(false),
        Err(nix::errno::Errno::ENOENT) => Ok(true),
        Err(error) => Err(Failure::new("named-stat", error)),
    }
}
#[derive(Clone, Copy)]
enum Parent {
    System,
    #[cfg(test)]
    Synthetic,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Empty,
    Pending,
    Linked,
    Final,
    Existing,
}
struct Owner {
    parent_path: PathBuf,
    parent_kind: Parent,
    parent: Option<File>,
    home: Option<File>,
    directory: Option<File>,
    file: Option<File>,
    parent_stamp: Option<Stamp>,
    home_stamp: Option<Stamp>,
    directory_stamp: Option<Stamp>,
    stage: Stage,
    #[cfg(test)]
    close_calls: usize,
    #[cfg(test)]
    lose_file_close: bool,
    #[cfg(test)]
    lose_link_sync: bool,
    #[cfg(test)]
    publication_calls: usize,
}
impl Owner {
    fn new(parent_path: &Path, parent_kind: Parent) -> Self {
        Self {
            parent_path: parent_path.to_owned(),
            parent_kind,
            parent: None,
            home: None,
            directory: None,
            file: None,
            parent_stamp: None,
            home_stamp: None,
            directory_stamp: None,
            stage: Stage::Empty,
            #[cfg(test)]
            close_calls: 0,
            #[cfg(test)]
            lose_file_close: false,
            #[cfg(test)]
            lose_link_sync: false,
            #[cfg(test)]
            publication_calls: 0,
        }
    }
    fn parent(&self) -> Result<&File> {
        self.parent
            .as_ref()
            .ok_or_else(|| Failure::refused("parent-owner"))
    }
    fn home(&self) -> Result<&File> {
        self.home
            .as_ref()
            .ok_or_else(|| Failure::refused("home-owner"))
    }
    fn directory(&self) -> Result<&File> {
        self.directory
            .as_ref()
            .ok_or_else(|| Failure::refused("directory-owner"))
    }
    fn file(&mut self) -> Result<&mut File> {
        self.file
            .as_mut()
            .ok_or_else(|| Failure::refused("file-owner"))
    }
    fn capture(&mut self, expected: Home) -> Result<()> {
        self.parent = Some(File::from(
            open(&self.parent_path, DIRECTORY_FLAGS, Mode::empty())
                .map_err(|error| Failure::new("parent-open", error))?,
        ));
        let parent = fd(self.parent()?)?;
        self.parent_stamp = Some(parent);
        let parent_valid = match self.parent_kind {
            Parent::System => parent.uid == 0 && parent.mode & 0o022 == 0,
            #[cfg(test)]
            Parent::Synthetic => parent.directory(geteuid().as_raw(), 0o700),
        };
        if !parent_valid {
            return Err(Failure::refused("parent-custody"));
        }
        self.home = Some(File::from(
            openat(self.parent()?, "agent", DIRECTORY_FLAGS, Mode::empty())
                .map_err(|error| Failure::new("home-open", error))?,
        ));
        let home = fd(self.home()?)?;
        self.home_stamp = Some(home);
        if !home.directory(geteuid().as_raw(), 0o700) || home.home() != expected {
            return Err(Failure::refused("home-correlation"));
        }
        self.current()?;
        if absent(self.home()?, DIRECTORY)? {
            self.current()?;
            mkdirat(self.home()?, DIRECTORY, Mode::from_bits_truncate(0o700))
                .map_err(|error| Failure::new("directory-create", error))?;
            self.home()?
                .sync_all()
                .map_err(|error| Failure::new("home-sync", error))?;
        }
        self.directory = Some(File::from(
            openat(self.home()?, DIRECTORY, DIRECTORY_FLAGS, Mode::empty())
                .map_err(|error| Failure::new("directory-open", error))?,
        ));
        let directory = fd(self.directory()?)?;
        self.directory_stamp = Some(directory);
        if !directory.directory(geteuid().as_raw(), 0o700) {
            return Err(Failure::refused("directory-custody"));
        }
        self.current()
    }
    fn current(&self) -> Result<()> {
        if let Some(expected) = self.parent_stamp {
            let actual = fd(self.parent()?)?;
            let absolute = File::from(
                open(&self.parent_path, DIRECTORY_FLAGS, Mode::empty())
                    .map_err(|error| Failure::new("parent-currency", error))?,
            );
            let checked = fd(&absolute).and_then(|stamp| {
                (stamp == expected && actual == expected)
                    .then_some(())
                    .ok_or_else(|| Failure::refused("parent-currency"))
            });
            let closed =
                close(absolute).map_err(|error| Failure::new("parent-currency-close", error));
            join(checked, closed)?;
        }
        if let Some(expected) = self.home_stamp {
            let actual = fd(self.home()?)?;
            if !actual.identity(expected) || actual != named(self.parent()?, "agent")? {
                return Err(Failure::refused("home-currency"));
            }
        }
        if let Some(expected) = self.directory_stamp {
            let actual = fd(self.directory()?)?;
            if !actual.identity(expected) || actual != named(self.home()?, DIRECTORY)? {
                return Err(Failure::refused("directory-currency"));
            }
        }
        Ok(())
    }
    fn begin(&mut self) -> Result<bool> {
        self.current()?;
        if !absent(self.directory()?, PENDING)? {
            return Err(Failure::refused("pending-exists"));
        }
        if !absent(self.directory()?, FINAL)? {
            self.file = Some(File::from(
                openat(
                    self.directory()?,
                    FINAL,
                    OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|error| Failure::new("existing-open", error))?,
            ));
            self.stage = Stage::Existing;
            return Ok(false);
        }
        self.file = Some(File::from(
            openat(
                self.directory()?,
                PENDING,
                OFlag::O_RDWR
                    | OFlag::O_CREAT
                    | OFlag::O_EXCL
                    | OFlag::O_NOFOLLOW
                    | OFlag::O_CLOEXEC,
                Mode::from_bits_truncate(0o600),
            )
            .map_err(|error| Failure::new("pending-open", error))?,
        ));
        self.stage = Stage::Pending;
        self.directory()?
            .sync_all()
            .map_err(|error| Failure::new("pending-directory-sync", error))?;
        Ok(true)
    }
    fn write_pending(&mut self, token: &[u8]) -> Result<()> {
        if self.stage != Stage::Pending {
            return Err(Failure::refused("write-order"));
        }
        self.current()?;
        self.file()?
            .write_all(token)
            .map_err(|error| Failure::new("pending-write", error))?;
        self.file()?
            .sync_all()
            .map_err(|error| Failure::new("pending-sync", error))?;
        self.read_current(token)
    }
    fn file_names(&self, stamp: Stamp) -> Result<()> {
        let directory = self.directory()?;
        match self.stage {
            Stage::Empty => Err(Failure::refused("file-order")),
            Stage::Pending => {
                if named(directory, PENDING)? == stamp {
                    Ok(())
                } else {
                    Err(Failure::refused("pending-currency"))
                }
            }
            Stage::Linked => {
                if named(directory, PENDING)? == stamp && named(directory, FINAL)? == stamp {
                    Ok(())
                } else {
                    Err(Failure::refused("linked-currency"))
                }
            }
            Stage::Final | Stage::Existing => {
                if named(directory, FINAL)? == stamp && absent(directory, PENDING)? {
                    Ok(())
                } else {
                    Err(Failure::refused("final-currency"))
                }
            }
        }
    }
    fn read_current(&mut self, token: &[u8]) -> Result<()> {
        self.current()?;
        let before = fd(self.file()?)?;
        let links = if self.stage == Stage::Linked { 2 } else { 1 };
        if SFlag::from_bits_truncate(before.mode) != SFlag::S_IFREG
            || before.mode & 0o7777 != 0o600
            || before.uid != geteuid().as_raw()
            || before.nlink != links
            || before.size
                != i64::try_from(token.len()).map_err(|error| Failure::new("token-bound", error))?
        {
            return Err(Failure::refused("file-custody"));
        }
        self.file_names(before)?;
        let file = self.file()?;
        file.seek(SeekFrom::Start(0))
            .map_err(|error| Failure::new("file-seek", error))?;
        let mut observed = Vec::new();
        file.take((super::input::LIMIT + 1) as u64)
            .read_to_end(&mut observed)
            .map_err(|error| Failure::new("file-read", error))?;
        if observed != token || fd(self.file()?)? != before {
            return Err(Failure::refused("file-bytes"));
        }
        self.file_names(before)?;
        self.current()
    }
    fn publish(&mut self, token: &[u8]) -> Result<()> {
        if self.stage != Stage::Pending {
            return Err(Failure::refused("publication-order"));
        }
        self.read_current(token)?;
        linkat(
            self.directory()?,
            PENDING,
            self.directory()?,
            FINAL,
            AtFlags::empty(),
        )
        .map_err(|error| Failure::new("no-replace-publication", error))?;
        self.stage = Stage::Linked;
        #[cfg(test)]
        {
            self.publication_calls += 1;
        }
        self.directory()?
            .sync_all()
            .map_err(|error| Failure::new("publication-sync", error))?;
        #[cfg(test)]
        if self.lose_link_sync {
            return Err(Failure::refused("publication-sync-ack-unknown"));
        }
        self.read_current(token)?;
        unlinkat(self.directory()?, PENDING, UnlinkatFlags::NoRemoveDir)
            .map_err(|error| Failure::new("pending-finalize", error))?;
        self.stage = Stage::Final;
        self.directory()?
            .sync_all()
            .map_err(|error| Failure::new("final-directory-sync", error))?;
        self.read_current(token)
    }
    fn execute(&mut self, token: &[u8], home: Home) -> Result<Home> {
        if token.is_empty() || token.len() > super::input::LIMIT {
            return Err(Failure::refused("token-bound"));
        }
        self.capture(home)?;
        if self.begin()? {
            self.write_pending(token)?;
            self.publish(token)?;
        } else {
            self.read_current(token)?;
        }
        Ok(home)
    }
    fn close_components(&mut self) -> Result<()> {
        let mut result = Ok(());
        for (index, slot) in [
            &mut self.file,
            &mut self.directory,
            &mut self.home,
            &mut self.parent,
        ]
        .into_iter()
        .enumerate()
        {
            let Some(file) = slot.take() else {
                continue;
            };
            #[cfg(test)]
            {
                self.close_calls += 1;
            }
            let closed = close(file).map_err(|error| Failure::new("consuming-close", error));
            #[cfg(test)]
            let closed = if index == 0 && self.lose_file_close {
                join(closed, Err(Failure::refused("close-ack-unknown")))
            } else {
                closed
            };
            #[cfg(not(test))]
            let _ = index;
            result = join(result, closed);
        }
        result
    }
    fn finish(&mut self, result: Result<Home>) -> Result<Home> {
        let checked = join(result, self.current());
        join(checked, self.close_components())
    }
}
pub(super) fn install(token: &[u8], home: Home) -> Result<Home> {
    let mut owner = Owner::new(Path::new("/home"), Parent::System);
    let result = owner.execute(token, home);
    owner.finish(result)
}
#[cfg(test)]
mod tests;
