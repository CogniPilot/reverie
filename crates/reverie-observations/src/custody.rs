//! `collector_user.py` custody: the owner home is the trust anchor, files are
//! private, regular, singly linked and stable across the read.
use crate::Refused;
use nix::fcntl::{OFlag, open};
use nix::sys::stat::{FileStat, Mode, fstat, lstat, stat};
use reverie_contracts::resource_history::{
    CONFIG_LIMIT, ObservationConfig, TAIL_BYTES, Tail, canonical_path, parse_observation_config,
};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path, PathBuf};

/// `MARKER` in the state directory.
const MARKER: &[u8] = b"{\"application\":\"reverie-user-observations\",\"version\":1}\n";

fn refused(why: &'static str) -> impl Fn(nix::Error) -> Refused {
    move |_| Refused(why)
}

/// The trust anchor of one command: the resolved owner home and the uid.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Owner {
    home: PathBuf,
    uid: u32,
}

/// `Path.home()`: `$HOME` when set, else the passwd entry. An empty `$HOME`
/// is `Path("")`, which resolves to the working directory.
fn current_home() -> Result<PathBuf, Refused> {
    let home = match std::env::var_os("HOME") {
        Some(home) => PathBuf::from(home),
        None => nix::unistd::User::from_uid(nix::unistd::getuid())
            .ok()
            .flatten()
            .map(|user| user.dir)
            .ok_or(Refused("Home unavailable"))?,
    };
    Ok(if home.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        home
    })
}

/// Path text as Python `str` code points, for `canonical`.
fn points(path: &Path) -> Vec<u32> {
    reverie_core::posix_text::decode(path.as_os_str().as_bytes())
}

/// `canonical(value)` for a host path.
fn canonical(path: &Path) -> Result<(), Refused> {
    if canonical_path(&points(path)) {
        Ok(())
    } else {
        Err(Refused("Canonical absolute path required"))
    }
}

/// `path.resolve(strict=False) != path`: true for a relative path, a `..`
/// component, or an existing prefix that is a symlink. `Path` already drops
/// `.` and repeated separators, as Python's does.
fn resolves_elsewhere(path: &Path) -> bool {
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return true;
    }
    let mut prefix = PathBuf::from("/");
    for component in path.components().skip(1) {
        prefix.push(component);
        match std::fs::symlink_metadata(&prefix) {
            Ok(meta) if meta.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
    false
}

fn stamp(meta: &FileStat) -> (u64, u64, i64, i64, i64, i64, i64) {
    (
        meta.st_dev,
        meta.st_ino,
        meta.st_size,
        meta.st_mtime,
        meta.st_mtime_nsec,
        meta.st_ctime,
        meta.st_ctime_nsec,
    )
}

fn unchanged(file: &File, path: &Path, before: &FileStat) -> bool {
    let now = fstat(file).ok();
    let named = lstat(path).ok();
    now.is_some_and(|now| stamp(&now) == stamp(before))
        && named.is_some_and(|named| stamp(&named) == stamp(before))
}

/// `os.fsencode` of a validated configuration path; a code point that has no
/// POSIX encoding cannot name an owned file, so it is refused.
fn path_of(points: &[u32]) -> Result<PathBuf, Refused> {
    reverie_core::posix_text::encode(points)
        .map(|bytes| PathBuf::from(std::ffi::OsString::from_vec(bytes)))
        .map_err(|_| Refused("Canonical absolute path required"))
}

/// The NVIDIA tool rule: immutable, root-owned, executable, under the store.
fn gpu_tool(points: &[u32]) -> Result<(), Refused> {
    let refusal = Refused("Select a matching immutable NVIDIA tool explicitly");
    let tool = path_of(points)?;
    let meta = stat(&tool).map_err(|_| refusal)?;
    let resolved = std::fs::canonicalize(&tool).map_err(|_| refusal)?;
    let regular = meta.st_mode & libc::S_IFMT == libc::S_IFREG;
    if !tool.starts_with("/nix/store")
        || resolved != tool
        || tool.file_name() != Some(std::ffi::OsStr::new("nvidia-smi"))
        || !regular
        || meta.st_uid != 0
        || meta.st_mode & 0o222 != 0
        || meta.st_mode & 0o111 == 0
    {
        return Err(refusal);
    }
    Ok(())
}

impl Owner {
    /// An explicit home (resolved strictly) for the calling uid.
    pub fn new(home: &Path) -> Result<Self, Refused> {
        let home = std::fs::canonicalize(home).map_err(|_| Refused("Home unavailable"))?;
        Ok(Self {
            home,
            uid: nix::unistd::getuid().as_raw(),
        })
    }

    /// `Path.home().resolve(strict=True)` for this process.
    pub fn current() -> Result<Self, Refused> {
        Self::new(&current_home()?)
    }

    /// `ancestry(path)`: a real descendant of the owner home whose existing
    /// ancestors (home included, the path itself not) are owned directories
    /// without group or other write.
    pub fn ancestry(&self, path: &Path) -> Result<(), Refused> {
        let refusal = Refused("User observation paths must be real descendants of the owner home");
        let unprotected = Refused("User observation ancestry is not owned and protected");
        let relative = path.strip_prefix(&self.home).map_err(|_| refusal)?;
        if relative.as_os_str().is_empty() || resolves_elsewhere(path) {
            return Err(refusal);
        }
        let mut checked = vec![self.home.clone()];
        let mut walk = self.home.clone();
        let mut parts = relative.components().peekable();
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                break;
            }
            walk.push(part);
            checked.push(walk.clone());
        }
        for (at, ancestor) in checked.iter().enumerate() {
            // Python's `p.exists()` follows links; a missing ancestor is skipped.
            if at > 0 && stat(ancestor).is_err() {
                continue;
            }
            let meta = lstat(ancestor).map_err(|_| unprotected)?;
            let directory = meta.st_mode & libc::S_IFMT == libc::S_IFDIR;
            if !directory || meta.st_uid != self.uid || meta.st_mode & 0o022 != 0 {
                return Err(unprotected);
            }
        }
        Ok(())
    }

    /// The private-file custody shared by `private_bytes` and `freshness_tail`.
    fn open_private(&self, path: &Path, why: &'static str) -> Result<(File, FileStat), Refused> {
        self.ancestry(path)?;
        let flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
        let fd = open(path, flags, Mode::empty()).map_err(refused(why))?;
        let file = File::from(fd);
        let meta = fstat(&file).map_err(refused(why))?;
        let regular = meta.st_mode & libc::S_IFMT == libc::S_IFREG;
        if !regular || meta.st_uid != self.uid || meta.st_nlink != 1 || meta.st_mode & 0o077 != 0 {
            return Err(Refused(why));
        }
        Ok((file, meta))
    }

    /// `private_bytes(path, limit)`.
    pub fn private_bytes(&self, path: &Path, limit: usize) -> Result<Vec<u8>, Refused> {
        let custody = "Private observation file custody refused";
        let (file, before) = self.open_private(path, custody)?;
        if usize::try_from(before.st_size).map_or(true, |size| size > limit) {
            return Err(Refused(custody));
        }
        let mut data = Vec::new();
        (&file)
            .take(u64::try_from(limit).unwrap_or(u64::MAX) + 1)
            .read_to_end(&mut data)
            .map_err(|_| Refused(custody))?;
        if data.len() > limit || !unchanged(&file, path, &before) {
            return Err(Refused("Observation file changed or exceeded its bound"));
        }
        Ok(data)
    }

    /// `freshness_tail(path)`: at most the last 256 KiB, without its possibly
    /// partial first record unless the whole file was read.
    pub fn freshness_tail(&self, path: &Path) -> Result<Tail, Refused> {
        let custody = "Freshness source custody refused";
        let (mut file, before) = self.open_private(path, custody)?;
        let size = u64::try_from(before.st_size).map_err(|_| Refused(custody))?;
        let offset = size.saturating_sub(TAIL_BYTES);
        let mut data = Vec::new();
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| (&file).take(size - offset).read_to_end(&mut data))
            .map_err(|_| Refused(custody))?;
        if data.len() as u64 != size - offset || !unchanged(&file, path, &before) {
            return Err(Refused("Freshness source changed"));
        }
        let charged = data.len();
        if offset > 0 {
            data = data
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or_else(Vec::new, |at| data[at + 1..].to_vec());
        }
        Ok(Tail {
            data,
            charged,
            complete: offset == 0,
        })
    }

    /// `configuration(path)`: the private configuration bytes and their checks.
    pub fn configuration(&self, path: &Path) -> Result<(Vec<u8>, ObservationConfig), Refused> {
        canonical(path)?;
        let raw = self.private_bytes(path, CONFIG_LIMIT)?;
        let config = parse_observation_config(&raw)?;
        let state = path_of(&config.state_directory)?;
        self.ancestry(&state)?;
        if Some(state.as_path()) == path.parent() || state.starts_with(path) {
            return Err(Refused("State must be separate from configuration"));
        }
        if let Some(tool) = &config.gpu_executable {
            gpu_tool(tool)?;
        }
        Ok((raw, config))
    }

    /// `state_directory(cfg)` without creation: private, owned, with its
    /// marker. Also returns the directory's (device, inode).
    pub fn state_directory(
        &self,
        config: &ObservationConfig,
    ) -> Result<(PathBuf, (u64, u64)), Refused> {
        let private = "User observation state must be private";
        let state = path_of(&config.state_directory)?;
        self.ancestry(&state)?;
        let meta = lstat(&state).map_err(refused(private))?;
        let directory = meta.st_mode & libc::S_IFMT == libc::S_IFDIR;
        if !directory || meta.st_uid != self.uid || meta.st_mode & 0o077 != 0 {
            return Err(Refused(private));
        }
        let marker = state.join(".reverie-user-observations.json");
        if self.private_bytes(&marker, CONFIG_LIMIT)? != MARKER {
            return Err(Refused("Wrong user observation marker"));
        }
        let followed = stat(&state).map_err(refused(private))?;
        Ok((state, (followed.st_dev, followed.st_ino)))
    }
}

/// `exclusive(path, data)`: a new private file (never replacing one, never
/// through a final symlink), synced, then its directory synced.
pub(crate) fn exclusive(path: &Path, data: &[u8]) -> Result<(), Refused> {
    use std::io::Write;
    let refusal = Refused("Exclusive observation write refused");
    let flags =
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let mut file =
        File::from(open(path, flags, Mode::from_bits_truncate(0o600)).map_err(refused(refusal.0))?);
    file.write_all(data)
        .and_then(|()| file.sync_all())
        .map_err(|_| refusal)?;
    let directory = path.parent().ok_or(refusal)?;
    let fd = open(
        directory,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(refused(refusal.0))?;
    File::from(fd).sync_all().map_err(|_| refusal)
}

/// `Path.mkdir(parents=True, mode=mode, exist_ok=True)`: missing parents
/// with the default mode, the leaf with `mode`.
pub(crate) fn make_directories(path: &Path, mode: u32) -> Result<(), Refused> {
    use std::os::unix::fs::DirBuilderExt;
    let refusal = Refused("Observation directory unavailable");
    if path.is_dir() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o777)
            .create(parent)
            .map_err(|_| refusal)?;
    }
    match std::fs::DirBuilder::new().mode(mode).create(path) {
        Ok(()) => Ok(()),
        Err(_) if path.is_dir() => Ok(()),
        Err(_) => Err(refusal),
    }
}

impl Owner {
    /// `state_directory(cfg, create=True)`: create the private directory and
    /// its marker, but never adopt existing content without the marker.
    pub(crate) fn create_state(&self, config: &ObservationConfig) -> Result<PathBuf, Refused> {
        let state = path_of(&config.state_directory)?;
        self.ancestry(&state)?;
        make_directories(&state, 0o700)?;
        let private = Refused("User observation state must be private");
        let meta = lstat(&state).map_err(|_| private)?;
        let directory = meta.st_mode & libc::S_IFMT == libc::S_IFDIR;
        if !directory || meta.st_uid != self.uid || meta.st_mode & 0o077 != 0 {
            return Err(private);
        }
        let marker = state.join(".reverie-user-observations.json");
        let present = stat(&marker).is_ok()
            || lstat(&marker).is_ok_and(|meta| meta.st_mode & libc::S_IFMT == libc::S_IFLNK);
        if !present {
            let mut entries = std::fs::read_dir(&state).map_err(|_| private)?;
            if entries.next().is_some() {
                return Err(Refused("Refusing to adopt existing observations"));
            }
            exclusive(&marker, MARKER)?;
        }
        if self.private_bytes(&marker, CONFIG_LIMIT)? != MARKER {
            return Err(Refused("Wrong user observation marker"));
        }
        Ok(state)
    }

    /// `operation(path)`: the exclusive, non-blocking unit-control lock next
    /// to the configuration.
    pub(crate) fn operation(&self, config: &Path) -> Result<nix::fcntl::Flock<File>, Refused> {
        let refusal = Refused("User observation lock refused");
        let lock = config
            .parent()
            .ok_or(refusal)?
            .join(".observations-control.lock");
        let flags = OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let file =
            File::from(open(&lock, flags, Mode::from_bits_truncate(0o600)).map_err(|_| refusal)?);
        let meta = fstat(&file).map_err(|_| refusal)?;
        let regular = meta.st_mode & libc::S_IFMT == libc::S_IFREG;
        if !regular || meta.st_uid != self.uid || meta.st_nlink != 1 || meta.st_mode & 0o077 != 0 {
            return Err(refusal);
        }
        nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock)
            .map_err(|_| refusal)
    }
}

/// `canonical(value)` for the configuration path given on the command line.
pub fn canonical_config(path: &Path) -> Result<(), Refused> {
    canonical(path)
}
