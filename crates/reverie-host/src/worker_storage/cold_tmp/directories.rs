//! The cold protocol owns its readable directory descriptors and rechecks the
//! original Python path spelling as well as held/named identity/type/UID/mode.
use super::*;
use std::{ffi::OsStr, io::Write};
#[derive(Clone, Copy)]
enum Privacy {
    Private,
    ExactPrivate,
}
#[derive(Clone, Copy)]
enum Creation {
    Reuse,
    Exclusive,
}
pub(super) struct Directory {
    pub(super) file: File,
    pub(super) text: PosixPath,
    pub(super) path: PathBuf,
    stamp: Stamp,
}
impl Directory {
    pub(super) fn open(text: PosixPath, uid: u32) -> Result<Self> {
        let path = native::python_path(&text.codepoints())?;
        need(
            native::resolve_strict_text(&text.codepoints())? == text,
            StorageFault::CanonicalPath,
        )?;
        let file = native::open_at(
            libc::AT_FDCWD,
            path.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        Self::adopt(text, path, file, uid, Privacy::Private)
    }
    fn adopt(
        text: PosixPath,
        path: PathBuf,
        file: File,
        uid: u32,
        privacy: Privacy,
    ) -> Result<Self> {
        let result = (|| {
            let stamp = Stamp::capture(&file.metadata()?);
            need(
                stamp.directory()
                    && stamp.uid == uid
                    && match privacy {
                        Privacy::Private => stamp.mode & 0o077 == 0,
                        Privacy::ExactPrivate => stamp.mode & 0o7777 == 0o700,
                    },
                StorageFault::PrivateDirectory,
            )?;
            Ok(stamp)
        })();
        let stamp = match result {
            Ok(stamp) => stamp,
            Err(error) => return finalized(Err(error), fs::close(file)),
        };
        let directory = Self {
            file,
            text,
            path,
            stamp,
        };
        match directory.check() {
            Ok(()) => Ok(directory),
            Err(error) => finalized(Err(error), directory.close()),
        }
    }
    pub(super) fn child(&self, name: &OsStr, uid: u32) -> Result<Self> {
        self.child_with(name, uid, Creation::Reuse)
    }
    pub(super) fn create_child(&self, name: &OsStr, uid: u32) -> Result<Self> {
        self.child_with(name, uid, Creation::Exclusive)
    }
    fn child_with(&self, name: &OsStr, uid: u32, creation: Creation) -> Result<Self> {
        self.check()?;
        need(
            Path::new(name).file_name() == Some(name),
            StorageFault::CanonicalPath,
        )?;
        let leaf = PosixPath::try_new(&native::python_text(Path::new(name)))
            .expect("filesystem codepoints");
        need(
            !leaf.is_absolute() && leaf.components().len() == 1 && !leaf.has_parent_component(),
            StorageFault::CanonicalPath,
        )?;
        match nix::sys::stat::mkdirat(&self.file, name, nix::sys::stat::Mode::S_IRWXU) {
            Ok(()) => self.file.sync_all()?,
            Err(nix::errno::Errno::EEXIST) if matches!(creation, Creation::Reuse) => {}
            Err(error) => return Err(std::io::Error::from(error).into()),
        }
        let file = native::open_at(
            self.file.as_raw_fd(),
            name,
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let child = Self::adopt(
            self.text.join(&leaf),
            self.path.join(name),
            file,
            uid,
            Privacy::ExactPrivate,
        )?;
        match self.check() {
            Ok(()) => Ok(child),
            Err(error) => finalized(Err(error), child.close()),
        }
    }
    /// The transaction already acknowledged its fixed no-replace rename. Move
    /// the SAME fd owner to that known name; failure closes it exactly once.
    pub(super) fn relocated(mut self, text: PosixPath) -> Result<Self> {
        let result = (|| {
            self.path = native::python_path(&text.codepoints())?;
            self.text = text;
            self.check()
        })();
        match result {
            Ok(()) => Ok(self),
            Err(error) => finalized(Err(error), self.close()),
        }
    }
    pub(super) fn stamp(&self) -> &Stamp {
        &self.stamp
    }
    pub(super) fn check(&self) -> Result<()> {
        let held = Stamp::capture(&self.file.metadata()?);
        let named = Stamp::capture(&std::fs::symlink_metadata(&self.path)?);
        need(
            self.stamp.same_directory(&held)
                && held.same_directory(&named)
                && native::resolve_strict_text(&self.text.codepoints())? == self.text,
            StorageFault::DirectoryChanged,
        )
    }
    pub(super) fn close(self) -> Result<()> {
        fs::close(self.file)
    }
    pub(super) fn publish(&self, name: &OsStr, raw: &[u8]) -> Result<Stamp> {
        self.check()?;
        let mut output = native::open_at_mode(
            self.file.as_raw_fd(),
            name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NONBLOCK,
            0o600,
        )?;
        let result = (|| {
            output.write_all(raw)?;
            output.sync_all()?;
            Ok(Stamp::capture(&output.metadata()?))
        })();
        let stamp = finalized(result, fs::close(output))?;
        self.file.sync_all()?;
        self.check()?;
        self.named(name, &stamp)?;
        Ok(stamp)
    }
    pub(super) fn named(&self, name: &OsStr, expected: &Stamp) -> Result<()> {
        self.check()?;
        need(
            Stamp::capture(&std::fs::symlink_metadata(self.path.join(name))?) == *expected,
            StorageFault::ColdTree,
        )
    }
}
