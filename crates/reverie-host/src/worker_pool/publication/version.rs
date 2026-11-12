use super::*;
use std::{
    ffi::OsStr,
    fs,
    io::Write,
    os::{
        fd::AsRawFd,
        unix::fs::{FileExt, MetadataExt},
    },
};
impl ControllerBirthPublication {
    pub(super) fn write_version(&mut self) -> Result<()> {
        self.check()?;
        let parent = self.directories.versions()?.as_raw_fd();
        self.writer = Some(native::open_at_mode(
            parent,
            OsStr::new(&self.filename),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
            0o400,
        )?);
        self.check()?;
        let writer = self.writer.as_mut().expect("owner stored before write");
        writer.write_all(&self.raw)?;
        writer.sync_all()?;
        self.check()?;
        self.verify_file(self.writer.as_ref().expect("retained writer"), 0o400)?;
        nix::sys::stat::fchmod(
            self.writer.as_ref().expect("retained writer"),
            nix::sys::stat::Mode::from_bits_truncate(0o440),
        )
        .map_err(io::Error::from)?;
        self.writer.as_ref().expect("retained writer").sync_all()?;
        self.check()?;
        self.reader = Some(native::open_at(
            parent,
            OsStr::new(&self.filename),
            libc::O_RDONLY | libc::O_NONBLOCK,
        )?);
        let writer_stamp =
            self.verify_file(self.writer.as_ref().expect("retained writer"), 0o440)?;
        need(
            self.verify_file(self.reader.as_ref().expect("retained reader"), 0o440)?
                == writer_stamp,
            "WORKER_POOL_PUBLICATION_VERSION_REBOUND",
        )?;
        self.stamp = Some(writer_stamp);
        // Consume the writable descriptor exactly once before publication.
        let closed = native::close(self.writer.take().expect("original writer"));
        self.close_unknown |= closed.is_err();
        closed?;
        self.observe_version()
    }
    pub(super) fn observe_version(&self) -> Result<()> {
        self.check()?;
        self.directories.versions()?;
        let stamp = self.verify_file(
            self.reader.as_ref().ok_or(PoolError::Refused(
                "WORKER_POOL_PUBLICATION_READER_REQUIRED",
            ))?,
            0o440,
        )?;
        need(
            Some(&stamp) == self.stamp.as_ref(),
            "WORKER_POOL_PUBLICATION_VERSION_CHANGED",
        )?;
        self.check()
    }
    fn verify_file(&self, file: &File, mode: u32) -> Result<native::Stamp> {
        let before = file.metadata()?;
        let ids = self.birth_data().broker().ids();
        need(
            before.is_file()
                && before.nlink() == 1
                && before.len() == self.raw.len() as u64
                && [before.uid(), before.gid()] == ids
                && before.mode() & 0o7777 == mode,
            "WORKER_POOL_PUBLICATION_VERSION_CUSTODY",
        )?;
        let mut raw = [0; 65_537];
        let count = file.read_at(&mut raw, 0)?;
        let stamp = native::Stamp::of(&before);
        let parent = self.directories.versions()?.as_raw_fd();
        let named = fs::symlink_metadata(format!("/proc/self/fd/{parent}/{}", self.filename))?;
        need(
            count == self.raw.len()
                && raw[..count] == self.raw
                && <[u8; 32]>::from(Sha256::digest(&raw[..count])) == self.digest
                && stamp == native::Stamp::of(&file.metadata()?)
                && stamp == native::Stamp::of(&named),
            "WORKER_POOL_PUBLICATION_VERSION_CHANGED",
        )?;
        Ok(stamp)
    }
}
