use crate::error::{Error, Result, finalized, need};
use nix::{
    fcntl::{self, OFlag},
    sys::{
        stat::Mode,
        statfs::{self, FsType},
        statvfs::{self, FsFlags},
    },
    unistd,
};
use std::{
    fs::File,
    io::{self, Read, Write},
    mem::MaybeUninit,
    os::unix::fs::MetadataExt,
    time::{Duration, Instant},
};

pub(crate) struct Files {
    files: Vec<Option<File>>,
    end: Instant,
    pub(crate) issued: bool,
    #[cfg(test)]
    lose_next_close_ack: bool,
}
impl Files {
    pub(crate) fn new() -> Self {
        Self {
            files: vec![],
            end: Instant::now() + Duration::from_secs(10),
            issued: false,
            #[cfg(test)]
            lose_next_close_ack: false,
        }
    }
    pub(crate) fn get(&self, index: usize) -> &File {
        self.files[index].as_ref().expect("retained file")
    }
    fn add(&mut self, file: File) -> usize {
        let index = self.files.len();
        self.files.push(Some(file));
        index
    }
    pub(crate) fn deadline(&self) -> Result<()> {
        need(Instant::now() < self.end, "BOXED_RESOURCE_DEADLINE")
    }
    pub(crate) fn root(&mut self, path: &str, magic: FsType, readonly: bool) -> Result<usize> {
        let fd = fcntl::open(
            path,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let index = self.add(File::from(fd));
        self.directory(index, magic, Some(readonly))?;
        Ok(index)
    }
    pub(crate) fn child(&mut self, parent: usize, name: &str, magic: FsType) -> Result<usize> {
        need(
            !name.is_empty() && !name.contains('/') && !matches!(name, "." | ".."),
            "BOXED_RESOURCE_COMPONENT",
        )?;
        let fd = fcntl::openat(
            self.get(parent),
            name,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let index = self.add(File::from(fd));
        self.directory(index, magic, None)?;
        Ok(index)
    }
    fn directory(&self, index: usize, magic: FsType, readonly: Option<bool>) -> Result<()> {
        let file = self.get(index);
        let meta = file.metadata()?;
        need(
            meta.is_dir()
                && statfs::fstatfs(file)
                    .map_err(io::Error::from)?
                    .filesystem_type()
                    == magic,
            "BOXED_RESOURCE_FILESYSTEM",
        )?;
        if magic == statfs::CGROUP2_SUPER_MAGIC {
            need(
                meta.uid() == 0 && meta.mode() & 0o022 == 0,
                "BOXED_RESOURCE_CGROUP_CUSTODY",
            )?;
        }
        if let Some(readonly) = readonly {
            need(
                statvfs::fstatvfs(file)
                    .map_err(io::Error::from)?
                    .flags()
                    .contains(FsFlags::ST_RDONLY)
                    == readonly,
                "BOXED_RESOURCE_MOUNT_MODE",
            )?;
        }
        Ok(())
    }
    pub(crate) fn identity(&self, index: usize) -> Result<(u64, u64)> {
        let meta = self.get(index).metadata()?;
        Ok((meta.dev(), meta.ino()))
    }
    pub(crate) fn storage(&mut self, path: &str, readonly: bool) -> Result<usize> {
        let fd = fcntl::open(
            path,
            OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let index = self.add(File::from(fd));
        need(
            self.get(index).metadata()?.is_dir(),
            "BOXED_STORAGE_DIRECTORY",
        )?;
        if readonly {
            need(
                statvfs::fstatvfs(self.get(index))
                    .map_err(io::Error::from)?
                    .flags()
                    .contains(FsFlags::ST_RDONLY),
                "BOXED_STORAGE_NOT_READONLY",
            )?;
        }
        Ok(index)
    }
    pub(crate) fn init_stat(&mut self) -> Result<String> {
        let fd = fcntl::open(
            "/proc",
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let root = self.add(File::from(fd));
        self.directory(root, statfs::PROC_SUPER_MAGIC, None)?;
        let init = self.child(root, "1", statfs::PROC_SUPER_MAGIC)?;
        let result = self.read(init, "stat", 4096);
        let close = [self.close_one(init), self.close_one(root)]
            .into_iter()
            .flatten()
            .collect();
        finalized(result, close)
    }
    pub(crate) fn read(&mut self, parent: usize, name: &str, maximum: usize) -> Result<String> {
        self.deadline()?;
        let fd = fcntl::openat(
            self.get(parent),
            name,
            OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let index = self.add(File::from(fd));
        let result = (|| {
            self.regular(index, parent)?;
            let mut raw = vec![];
            self.get(index)
                .take((maximum + 1) as u64)
                .read_to_end(&mut raw)?;
            need(raw.len() <= maximum, "BOXED_RESOURCE_READ_BOUND")?;
            String::from_utf8(raw).map_err(|_| Error::Refused("BOXED_RESOURCE_ENCODING"))
        })();
        let close = self.close_one(index);
        finalized(result, close.into_iter().collect())
    }
    pub(crate) fn entries(&mut self, index: usize) -> Result<Vec<String>> {
        self.deadline()?;
        let fd = fcntl::openat(
            self.get(index),
            ".",
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let cursor = self.add(File::from(fd));
        let result = self.enumerate(index, cursor);
        finalized(result, self.close_one(cursor).into_iter().collect())
    }
    fn enumerate(&self, original: usize, cursor: usize) -> Result<Vec<String>> {
        use rustix::fs::{FileType, RawDir};
        need(
            self.identity(original)? == self.identity(cursor)?,
            "BOXED_RESOURCE_ENUMERATOR_IDENTITY",
        )?;
        let mut buffer = [MaybeUninit::uninit(); 8192];
        // RawDir borrows this exact retained File; dropping it owns no close.
        let mut iterator = RawDir::new(self.get(cursor), &mut buffer);
        let mut names = vec![];
        let mut entries = 0;
        while let Some(entry) = iterator.next() {
            self.deadline()?;
            entries += 1;
            need(entries <= 512, "BOXED_RESOURCE_ENTRY_BOUND")?;
            let entry = entry.map_err(io::Error::from)?;
            let name = entry
                .file_name()
                .to_str()
                .map_err(|_| Error::Refused("BOXED_RESOURCE_CHILD_NAME"))?;
            if matches!(name, "." | "..") {
                continue;
            }
            match entry.file_type() {
                FileType::Directory => names.push(name.to_owned()),
                FileType::RegularFile => (),
                _ => return Err(Error::Refused("BOXED_RESOURCE_DIRECTORY_TYPE")),
            }
            need(names.len() <= 65, "BOXED_RESOURCE_CHILD_BOUND")?;
        }
        names.sort();
        need(
            !names.windows(2).any(|pair| pair[0] == pair[1]),
            "BOXED_RESOURCE_DUPLICATE_CHILD",
        )?;
        Ok(names)
    }
    pub(crate) fn write(&mut self, parent: usize, name: &str, value: &str) -> Result<()> {
        self.deadline()?;
        let fd = fcntl::openat(
            self.get(parent),
            name,
            OFlag::O_WRONLY | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let index = self.add(File::from(fd));
        self.regular(index, parent)?;
        self.issued = true;
        let result = self
            .get(index)
            .write_all(value.as_bytes())
            .map_err(Error::from);
        let close = self.close_one(index);
        finalized(result, close.into_iter().collect())
    }
    fn regular(&self, index: usize, parent: usize) -> Result<()> {
        let file = self.get(index);
        let meta = file.metadata()?;
        let magic = statfs::fstatfs(self.get(parent))
            .map_err(io::Error::from)?
            .filesystem_type();
        need(
            meta.is_file()
                && statfs::fstatfs(file)
                    .map_err(io::Error::from)?
                    .filesystem_type()
                    == magic,
            "BOXED_RESOURCE_FILE_TYPE",
        )?;
        if magic == statfs::CGROUP2_SUPER_MAGIC {
            need(
                meta.uid() == 0 && meta.mode() & 0o022 == 0,
                "BOXED_RESOURCE_FILE_CUSTODY",
            )?;
        }
        Ok(())
    }
    fn close_one(&mut self, index: usize) -> Option<io::Error> {
        let file = self.files[index].take()?;
        let result = unistd::close(file).map_err(io::Error::from).err();
        #[cfg(test)]
        if std::mem::take(&mut self.lose_next_close_ack) && result.is_none() {
            return Some(io::Error::from_raw_os_error(nix::libc::EINTR));
        }
        result
    }
    #[cfg(test)]
    pub(crate) fn lose_next_close_ack(&mut self) {
        self.lose_next_close_ack = true;
    }
    pub(crate) fn release(&mut self, index: usize) -> Result<()> {
        finalized(Ok(()), self.close_one(index).into_iter().collect())
    }
    pub(crate) fn close_all(&mut self) -> Vec<io::Error> {
        (0..self.files.len())
            .filter_map(|index| self.close_one(index))
            .collect()
    }
}
