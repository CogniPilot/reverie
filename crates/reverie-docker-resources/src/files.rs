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

/// A test's view of one open about to be issued, by full path. It may change
/// its owned tree first, or return the error the kernel would give.
#[cfg(test)]
pub(crate) type Interception = Box<dyn FnMut(&str) -> Option<io::Error>>;

struct Retained {
    file: File,
    /// The path this helper opened the file by. Used in failure reports only.
    path: String,
    subject: Option<String>,
}
pub(crate) struct Files {
    files: Vec<Option<Retained>>,
    end: Instant,
    pub(crate) issued: bool,
    /// Control files whose issued value was read back, in order.
    confirmed: Vec<String>,
    #[cfg(test)]
    lose_next_close_ack: bool,
    #[cfg(test)]
    interception: Option<Interception>,
}
impl Files {
    pub(crate) fn new() -> Self {
        Self {
            files: vec![],
            end: Instant::now() + Duration::from_secs(10),
            issued: false,
            confirmed: vec![],
            #[cfg(test)]
            lose_next_close_ack: false,
            #[cfg(test)]
            interception: None,
        }
    }
    fn retained(&self, index: usize) -> &Retained {
        self.files[index].as_ref().expect("retained file")
    }
    pub(crate) fn get(&self, index: usize) -> &File {
        &self.retained(index).file
    }
    fn add(&mut self, file: File, path: String, subject: Option<String>) -> usize {
        let index = self.files.len();
        self.files.push(Some(Retained {
            file,
            path,
            subject,
        }));
        index
    }
    fn below(&self, parent: usize, name: &str) -> String {
        format!("{}/{name}", self.retained(parent).path)
    }
    /// Names the object of a failed call: the retained file itself, or `name` below it.
    fn located<T>(&self, index: usize, name: Option<&str>, result: Result<T>) -> Result<T> {
        result.map_err(|error| {
            let retained = self.retained(index);
            let error = error.at(|| match name {
                Some(name) => self.below(index, name),
                None => retained.path.clone(),
            });
            match &retained.subject {
                Some(subject) => error.of(|| subject.clone()),
                None => error,
            }
        })
    }
    /// Records whose object a retained directory is. Directories opened below
    /// it afterwards inherit that.
    pub(crate) fn name(&mut self, index: usize, subject: &str) {
        if let Some(retained) = self.files[index].as_mut() {
            retained.subject = Some(subject.to_owned());
        }
    }
    pub(crate) fn deadline(&self) -> Result<()> {
        need(Instant::now() < self.end, "BOXED_RESOURCE_DEADLINE")
    }
    fn open(&mut self, path: &str, access: OFlag) -> Result<usize> {
        let fd = fcntl::open(
            path,
            access | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|errno| Error::from(io::Error::from(errno)).at(|| path.to_owned()))?;
        Ok(self.add(File::from(fd), path.to_owned(), None))
    }
    pub(crate) fn root(&mut self, path: &str, magic: FsType, readonly: bool) -> Result<usize> {
        let index = self.open(path, OFlag::O_RDONLY)?;
        let checked = self.directory(index, magic, Some(readonly));
        self.located(index, None, checked)?;
        Ok(index)
    }
    pub(crate) fn child(&mut self, parent: usize, name: &str, magic: FsType) -> Result<usize> {
        need(
            !name.is_empty() && !name.contains('/') && !matches!(name, "." | ".."),
            "BOXED_RESOURCE_COMPONENT",
        )?;
        let opened = self.open_child(parent, name, magic);
        self.located(parent, Some(name), opened)
    }
    fn open_child(&mut self, parent: usize, name: &str, magic: FsType) -> Result<usize> {
        #[cfg(test)]
        self.intercept(parent, name)?;
        let fd = fcntl::openat(
            self.get(parent),
            name,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let subject = self.retained(parent).subject.clone();
        let index = self.add(File::from(fd), self.below(parent, name), subject);
        let checked = self.directory(index, magic, None);
        if checked.is_ok() {
            return Ok(index);
        }
        // A refused directory is not retained: a caller may open thousands.
        self.released(index, checked.map(|()| index))
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
        let meta = self.get(index).metadata().map_err(Error::from);
        let meta = self.located(index, None, meta)?;
        Ok((meta.dev(), meta.ino()))
    }
    pub(crate) fn storage(&mut self, path: &str, readonly: bool) -> Result<usize> {
        let index = self.open(path, OFlag::O_PATH)?;
        let checked = self.storage_directory(index, readonly);
        self.located(index, None, checked)?;
        Ok(index)
    }
    fn storage_directory(&self, index: usize, readonly: bool) -> Result<()> {
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
        Ok(())
    }
    pub(crate) fn init_stat(&mut self) -> Result<String> {
        let root = self.open("/proc", OFlag::O_RDONLY)?;
        let checked = self.directory(root, statfs::PROC_SUPER_MAGIC, None);
        self.located(root, None, checked)?;
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
        let value = self.read_bounded(parent, name, maximum);
        self.located(parent, Some(name), value)
    }
    fn read_bounded(&mut self, parent: usize, name: &str, maximum: usize) -> Result<String> {
        #[cfg(test)]
        self.intercept(parent, name)?;
        let fd = fcntl::openat(
            self.get(parent),
            name,
            OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let index = self.add(File::from(fd), self.below(parent, name), None);
        let result = (|| {
            self.regular(index, parent)?;
            let mut raw = vec![];
            self.get(index)
                .take((maximum + 1) as u64)
                .read_to_end(&mut raw)?;
            need(raw.len() <= maximum, "BOXED_RESOURCE_READ_BOUND")?;
            String::from_utf8(raw).map_err(|_| Error::Refused("BOXED_RESOURCE_ENCODING"))
        })();
        self.released(index, result)
    }
    pub(crate) fn entries(&mut self, index: usize) -> Result<Vec<String>> {
        self.deadline()?;
        let names = self.enumerated(index);
        self.located(index, None, names)
    }
    fn enumerated(&mut self, index: usize) -> Result<Vec<String>> {
        let fd = fcntl::openat(
            self.get(index),
            ".",
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let cursor = self.add(File::from(fd), self.retained(index).path.clone(), None);
        let result = self.enumerate(index, cursor);
        self.released(cursor, result)
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
        let written = self.write_once(parent, name, value);
        self.located(parent, Some(name), written)
    }
    fn write_once(&mut self, parent: usize, name: &str, value: &str) -> Result<()> {
        let fd = fcntl::openat(
            self.get(parent),
            name,
            OFlag::O_WRONLY | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(io::Error::from)?;
        let index = self.add(File::from(fd), self.below(parent, name), None);
        self.regular(index, parent)?;
        self.issued = true;
        let result = self
            .get(index)
            .write_all(value.as_bytes())
            .map_err(Error::from);
        self.released(index, result)
    }
    /// Records that the value issued to a control file was read back from it.
    pub(crate) fn confirm(&mut self, name: &str) {
        self.confirmed.push(name.to_owned());
    }
    /// The one line a failed helper prints. Earlier helpers printed only the
    /// error and `effectIssued`, and a caller may match that line exactly, so
    /// it is unchanged unless a write was confirmed before the failure.
    pub(crate) fn failure(&self, error: &Error) -> String {
        let confirmed = if self.confirmed.is_empty() {
            String::new()
        } else {
            format!("; confirmed={}", self.confirmed.join(","))
        };
        format!("{error}{confirmed}; effectIssued={}", self.issued)
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
        let retained = self.files[index].take()?;
        let result = unistd::close(retained.file).map_err(io::Error::from).err();
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
    #[cfg(test)]
    pub(crate) fn intercept_with(&mut self, interception: Interception) {
        self.interception = Some(interception);
    }
    #[cfg(test)]
    fn intercept(&mut self, parent: usize, name: &str) -> Result<()> {
        let path = self.below(parent, name);
        match self.interception.as_mut().and_then(|seen| seen(&path)) {
            Some(error) => Err(error.into()),
            None => Ok(()),
        }
    }
    /// Closes one retained file, keeping both `result` and a failed close.
    pub(crate) fn released<T>(&mut self, index: usize, result: Result<T>) -> Result<T> {
        finalized(result, self.close_one(index).into_iter().collect())
    }
    pub(crate) fn release(&mut self, index: usize) -> Result<()> {
        self.released(index, Ok(()))
    }
    pub(crate) fn close_all(&mut self) -> Vec<io::Error> {
        (0..self.files.len())
            .filter_map(|index| self.close_one(index))
            .collect()
    }
}
