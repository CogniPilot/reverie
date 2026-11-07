//! Janitor's bounded own-directory plus ancestor key inventory. No regular
//! payloads are read, and symlinks are never followed into another tree.
use super::*;
pub(in crate::worker_storage::cold_tmp) struct ClearKeys {
    pub(in crate::worker_storage::cold_tmp) all: BTreeSet<String>,
    pub(in crate::worker_storage::cold_tmp) directories: BTreeSet<Key>,
}
impl ClearKeys {
    pub(in crate::worker_storage::cold_tmp) fn observe(
        root: &File,
        target: &PosixPath,
        stop: &PosixPath,
        end: Instant,
    ) -> Result<Self> {
        let mut value = Self {
            all: BTreeSet::new(),
            directories: BTreeSet::new(),
        };
        let mut pending = vec![Vec::new()];
        let mut count = 0;
        while let Some(parts) = pending.pop() {
            check(end)?;
            let directory = open(root, &parts)?;
            let result = value.directory(&directory, &parts, end, &mut count, &mut pending);
            finalized(result, fs::close(directory))?;
        }
        let mut parent = target.parent();
        loop {
            check(end)?;
            let info = std::fs::symlink_metadata(native::python_path(&parent.codepoints())?)?;
            need(info.is_dir(), StorageFault::ColdLease)?;
            value.insert((info.dev(), info.ino()), false);
            if &parent == stop || parent.parent() == parent {
                break;
            }
            parent = parent.parent();
        }
        Ok(value)
    }
    fn insert(&mut self, key: Key, own: bool) {
        self.all.insert(format!("{}-{}", key.0, key.1));
        if own {
            self.directories.insert(key);
        }
    }
    fn directory(
        &mut self,
        file: &File,
        parts: &[OsString],
        end: Instant,
        count: &mut usize,
        pending: &mut Vec<Vec<OsString>>,
    ) -> Result<()> {
        let info = file.metadata()?;
        need(info.is_dir(), StorageFault::ColdLease)?;
        self.insert((info.dev(), info.ino()), true);
        let names = raw_names(file, MAX_ENTRIES - *count, end)?;
        *count += names.len();
        for name in names {
            check(end)?;
            let info = nix::sys::stat::fstatat(
                file,
                name.as_os_str(),
                nix::fcntl::AtFlags::AT_SYMLINK_NOFOLLOW,
            )
            .map_err(std::io::Error::from)?;
            if info.st_mode & libc::S_IFMT == libc::S_IFDIR {
                let mut child = parts.to_vec();
                child.push(name);
                pending.push(child);
            }
        }
        Ok(())
    }
}
fn open(root: &File, parts: &[OsString]) -> Result<File> {
    let mut file = native::open_at(
        root.as_raw_fd(),
        OsStr::new("."),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    let result = (|| {
        for part in parts {
            let next = native::open_at(file.as_raw_fd(), part, libc::O_RDONLY | libc::O_DIRECTORY)?;
            let previous = std::mem::replace(&mut file, next);
            fs::close(previous)?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(file),
        Err(error) => finalized(Err(error), fs::close(file)),
    }
}
