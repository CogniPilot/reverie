use super::{
    ChildCause, ChildCleanup, ChildError, ChildPhase, RecordDisposition,
    directory::{self, Directory},
    error::Result,
};
use crate::native::{self, Stamp};
use reverie_contracts::worker_child::PrivateChildRecord;
use std::{
    ffi::OsString,
    fs::File,
    io::Read,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::Path,
};
struct Record {
    name: OsString,
    directory: Option<Directory>,
    data: Option<File>,
    anchor: Option<File>,
    stamp: Option<Stamp>,
    state: RecordDisposition,
}
pub(super) fn consume(path: &Path, root: &Path) -> Result<PrivateChildRecord> {
    let mut record = Record::open(path, root)?;
    let result = (|| {
        let bytes = record.read()?;
        let parsed = PrivateChildRecord::decode(&bytes)
            .map_err(|cause| ChildError::new(ChildPhase::Parse, ChildCause::Data(cause)))?;
        record.consume()?;
        Ok(parsed)
    })();
    record.finish(result)
}
fn error(cause: ChildCause) -> ChildError {
    ChildError::new(ChildPhase::Record, cause)
}
fn io(cause: std::io::Error) -> ChildError {
    error(ChildCause::Io(cause))
}
impl Record {
    fn open(path: &Path, root: &Path) -> Result<Self> {
        let name = directory::name(path, root)?;
        let directory = Directory::open(root)?;
        let mut record = Self {
            name,
            directory: Some(directory),
            data: None,
            anchor: None,
            stamp: None,
            state: RecordDisposition::Untouched,
        };
        if let Err(cause) = record.prepare() {
            return record.finish(Err(cause));
        }
        Ok(record)
    }
    fn directory(&self) -> &File {
        self.directory.as_ref().expect("held launch parent").file()
    }
    fn prepare(&mut self) -> Result<()> {
        self.anchor = Some(
            native::open_at(self.directory().as_raw_fd(), &self.name, libc::O_PATH).map_err(io)?,
        );
        let info = self
            .anchor
            .as_ref()
            .expect("opened anchor")
            .metadata()
            .map_err(io)?;
        if !info.is_file() || info.uid() != native::uid() || info.mode() & 0o077 != 0 {
            return Err(error(ChildCause::Custody));
        }
        self.stamp = Some(Stamp::of(&info));
        self.data = Some(
            native::open_at(
                self.directory().as_raw_fd(),
                &self.name,
                libc::O_RDONLY | libc::O_NONBLOCK,
            )
            .map_err(io)?,
        );
        if Stamp::of(
            &self
                .data
                .as_ref()
                .expect("opened record")
                .metadata()
                .map_err(io)?,
        ) != *self.stamp.as_ref().expect("record stamp")
        {
            return Err(error(ChildCause::Changed));
        }
        self.recheck()
    }
    fn read(&mut self) -> Result<Vec<u8>> {
        let mut file = self.data.take().expect("unread record");
        let result = (|| {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).map_err(io)?;
            if Stamp::of(&file.metadata().map_err(io)?)
                != *self.stamp.as_ref().expect("record stamp")
                || bytes.len() as u64 != file.metadata().map_err(io)?.len()
            {
                return Err(error(ChildCause::Changed));
            }
            self.recheck()?;
            #[cfg(test)]
            super::test_hooks::run(super::test_hooks::Point::Read)?;
            Ok(bytes)
        })();
        directory::finalized(result, file, self.state, ChildCleanup::RecordDataClose)
    }
    fn recheck(&self) -> Result<()> {
        self.directory.as_ref().expect("held parent").recheck()?;
        let current =
            native::open_at(self.directory().as_raw_fd(), &self.name, libc::O_PATH).map_err(io)?;
        let result = (|| {
            let expected = self.stamp.as_ref().expect("record stamp");
            if Stamp::of(&current.metadata().map_err(io)?) != *expected
                || Stamp::of(
                    &self
                        .anchor
                        .as_ref()
                        .expect("held anchor")
                        .metadata()
                        .map_err(io)?,
                ) != *expected
            {
                return Err(error(ChildCause::Changed));
            }
            Ok(())
        })();
        directory::finalized(result, current, self.state, ChildCleanup::RecordAnchorClose)
    }
    fn consume(&mut self) -> Result<()> {
        self.recheck()?;
        #[cfg(test)]
        super::test_hooks::run(super::test_hooks::Point::BeforeUnlink)?;
        if native::child_signals::signal().is_some() {
            return Err(ChildError::new(ChildPhase::Consume, ChildCause::Cancelled));
        }
        self.state = RecordDisposition::UnlinkAttempted;
        native::unlink_child_record(self.directory(), &self.name).map_err(|cause| {
            ChildError::new(ChildPhase::Consume, ChildCause::Io(cause)).spent(self.state)
        })?;
        #[cfg(test)]
        super::test_hooks::run(super::test_hooks::Point::AfterUnlink)?;
        self.state = RecordDisposition::Consumed;
        Ok(())
    }
    fn finish<T>(mut self, mut result: Result<T>) -> Result<T> {
        for (file, fault) in [
            (self.data.take(), ChildCleanup::RecordDataClose),
            (self.anchor.take(), ChildCleanup::RecordAnchorClose),
        ] {
            if let Some(file) = file {
                result = directory::finalized(result, file, self.state, fault);
            }
        }
        self.directory.take().expect("held parent").finish(
            result.map_err(|cause| cause.spent(self.state)),
            self.state,
            ChildCleanup::RecordDirectoryClose,
        )
    }
}
