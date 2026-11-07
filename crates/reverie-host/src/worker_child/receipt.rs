//! Private command-exit DATA, never provider/engine cleanup or owner authority.
//! Publication is exclusive; uncertainty never triggers rollback/retry.
use super::{
    ChildCause, ChildCleanup, ChildError, ChildPhase, RecordDisposition,
    directory::{self, Directory},
    error::Result,
};
use crate::native::{self, Stamp};
use std::{
    ffi::OsString,
    fs::File,
    io::{Read, Write},
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::Path,
};
struct Receipt {
    directory: Option<Directory>,
    name: OsString,
    temporary: OsString,
    writer: Option<File>,
    anchor: Option<File>,
    prepared: Option<Stamp>,
    created: bool,
    attempted: bool,
}
pub(super) fn publish(path: &Path, root: &Path, status: u8) -> Result<()> {
    let name = directory::name(path, root).map_err(phase)?;
    let mut temporary = name.clone();
    temporary.push(".tmp");
    let directory = Directory::open(root).map_err(phase)?;
    let mut receipt = Receipt {
        directory: Some(directory),
        name,
        temporary,
        writer: None,
        anchor: None,
        prepared: None,
        created: false,
        attempted: false,
    };
    let result = receipt.write(status);
    receipt.finish(result)
}
impl Receipt {
    fn directory(&self) -> &Directory {
        self.directory.as_ref().expect("held receipt parent")
    }
    fn write(&mut self, status: u8) -> Result<()> {
        self.directory().recheck().map_err(phase)?;
        self.writer = Some(
            native::create_child_receipt(self.directory().file(), &self.temporary).map_err(io)?,
        );
        self.created = true;
        self.anchor = Some(
            native::open_at(
                self.directory().file().as_raw_fd(),
                &self.temporary,
                libc::O_PATH,
            )
            .map_err(io)?,
        );
        let data = status.to_string().into_bytes();
        let file = self.writer.as_mut().expect("exclusive receipt temp");
        file.write_all(&data).map_err(io)?;
        file.sync_all().map_err(io)?;
        let info = file.metadata().map_err(io)?;
        if !info.is_file()
            || info.uid() != native::uid()
            || info.nlink() != 1
            || info.mode() & 0o777 != 0o600
            || info.len() != data.len() as u64
        {
            return Err(error(ChildCause::Custody));
        }
        let stamp = Stamp::of(&info);
        let result = directory::finalized(
            Ok(()),
            self.writer.take().expect("owned writer"),
            RecordDisposition::Delegated,
            ChildCleanup::ReceiptWriterClose,
        )
        .map_err(phase);
        result?;
        self.prepared = Some(stamp);
        self.check(&self.temporary)?;
        self.directory().recheck().map_err(phase)?;
        #[cfg(test)]
        super::test_hooks::run(super::test_hooks::Point::BeforePublish)?;
        self.check(&self.temporary)?;
        self.directory().recheck().map_err(phase)?;
        self.attempted = true;
        if let Err(cause) =
            native::publish_child_receipt(self.directory().file(), &self.temporary, &self.name)
        {
            if cause.raw_os_error() == Some(libc::EEXIST) {
                self.attempted = false;
            }
            return Err(io(cause));
        }
        #[cfg(test)]
        super::test_hooks::run(super::test_hooks::Point::AfterPublish)?;
        let published = Stamp::of(
            &self
                .anchor
                .as_ref()
                .expect("held receipt anchor")
                .metadata()
                .map_err(io)?,
        );
        if !self
            .prepared
            .as_ref()
            .expect("prepared stamp")
            .matches_rename_metadata(&published)
        {
            return Err(error(ChildCause::Changed));
        }
        // The known rename may update ctime, but no other identity/content
        // metadata is adopted. Readback below still verifies the exact payload.
        self.prepared = Some(published);
        self.directory().file().sync_all().map_err(io)?;
        self.directory().recheck().map_err(phase)?;
        self.check(&self.name)?;
        self.readback(&data)
    }
    fn check(&self, name: &OsString) -> Result<()> {
        let current =
            native::open_at(self.directory().file().as_raw_fd(), name, libc::O_PATH).map_err(io)?;
        let checked = (|| {
            let expected = self.prepared.as_ref().expect("prepared receipt stamp");
            if Stamp::of(&current.metadata().map_err(io)?) != *expected
                || Stamp::of(
                    &self
                        .anchor
                        .as_ref()
                        .expect("held receipt anchor")
                        .metadata()
                        .map_err(io)?,
                ) != *expected
            {
                return Err(error(ChildCause::Changed));
            }
            Ok(())
        })();
        directory::finalized(
            checked,
            current,
            RecordDisposition::Delegated,
            ChildCleanup::ReceiptAnchorClose,
        )
        .map_err(phase)
    }
    fn readback(&self, data: &[u8]) -> Result<()> {
        let mut file = native::open_at(
            self.directory().file().as_raw_fd(),
            &self.name,
            libc::O_RDONLY | libc::O_NONBLOCK,
        )
        .map_err(io)?;
        let checked = (|| {
            let mut bytes = Vec::new();
            (&mut file).take(4).read_to_end(&mut bytes).map_err(io)?;
            if bytes != data
                || Stamp::of(&file.metadata().map_err(io)?)
                    != *self.prepared.as_ref().expect("prepared stamp")
            {
                return Err(error(ChildCause::Changed));
            }
            self.check(&self.name)
        })();
        directory::finalized(
            checked,
            file,
            RecordDisposition::Delegated,
            ChildCleanup::ReceiptAnchorClose,
        )
        .map_err(phase)
    }
    fn finish(mut self, mut result: Result<()>) -> Result<()> {
        if result.is_err() && self.created && !self.attempted {
            result = result.map_err(|error| self.cleanup_temporary(error));
        }
        for (file, fault) in [
            (self.writer.take(), ChildCleanup::ReceiptWriterClose),
            (self.anchor.take(), ChildCleanup::ReceiptAnchorClose),
        ] {
            if let Some(file) = file {
                result = directory::finalized(result, file, RecordDisposition::Delegated, fault)
                    .map_err(phase);
            }
        }
        let result = self
            .directory
            .take()
            .expect("held receipt parent")
            .finish(
                result,
                RecordDisposition::Delegated,
                ChildCleanup::ReceiptDirectoryClose,
            )
            .map_err(phase);
        if self.attempted {
            result.map_err(|error| error.finalizer(ChildCleanup::ReceiptPublication))
        } else {
            result
        }
    }
    fn cleanup_temporary(&self, error: ChildError) -> ChildError {
        if self.prepared.is_none() {
            return error.finalizer(ChildCleanup::ReceiptTemporaryRetained);
        }
        if let Err(cleanup) = self.check(&self.temporary) {
            return error
                .with_cleanup_from(&cleanup)
                .finalizer(ChildCleanup::ReceiptTemporaryRetained);
        }
        if native::unlink_child_record(self.directory().file(), &self.temporary).is_err() {
            error.finalizer(ChildCleanup::ReceiptTemporaryRetained)
        } else {
            error
        }
    }
}
fn error(cause: ChildCause) -> ChildError {
    ChildError::new(ChildPhase::Receipt, cause).spent(RecordDisposition::Delegated)
}
fn io(cause: std::io::Error) -> ChildError {
    error(ChildCause::Io(cause))
}
fn phase(error: ChildError) -> ChildError {
    error
        .at_phase(ChildPhase::Receipt)
        .spent(RecordDisposition::Delegated)
}
