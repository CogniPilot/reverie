use super::*;
use reverie_contracts::{storage_identity::MetadataText, worker_cold_tmp::ReferenceFdHeader};
use reverie_core::PythonText;
use std::{
    io::{BufRead, BufReader, Read},
    os::unix::fs::OpenOptionsExt,
};
pub(super) fn path_text(path: PathBuf) -> MetadataText {
    MetadataText::from_python_text(
        PythonText::try_new(native::python_text(&path)).expect("filesystem codepoints"),
    )
}
impl Observer<'_> {
    pub(super) fn fds(&mut self, base: &Path, ignored: i32) -> Result<BTreeSet<UnsignedInteger>> {
        let descriptors = match directory_names(&base.join("fd"), 8192, self.end) {
            Ok(descriptors) => descriptors,
            Err(error) if denied(&error) => {
                self.unknown(UnknownReference::FdInventory)?;
                Vec::new()
            }
            Err(error) => return Err(error),
        };
        let mut sockets = BTreeSet::new();
        for descriptor in descriptors {
            check(self.end)?;
            let text = descriptor
                .to_str()
                .ok_or(StorageError::Refused(StorageFault::ColdReference))?;
            need(
                !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()),
                StorageFault::ColdReference,
            )?;
            self.report.note_fd()?;
            if self.pid == std::process::id() && text.parse::<i32>().ok() == Some(ignored) {
                continue;
            }
            self.fd(base, &descriptor, &mut sockets)?;
        }
        Ok(sockets)
    }
    fn fd(
        &mut self,
        base: &Path,
        name: &OsStr,
        sockets: &mut BTreeSet<UnsignedInteger>,
    ) -> Result<()> {
        let node = base.join("fd").join(name);
        let held = match std::fs::metadata(&node) {
            Ok(held) => Some(held),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                self.unknown(UnknownReference::FdIdentity)?;
                None
            }
            Err(error) => return Err(error.into()),
        };
        let link = match std::fs::read_link(&node) {
            Ok(link) => Some(path_text(link)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                self.unknown(UnknownReference::FdPath)?;
                None
            }
            Err(error) => return Err(error.into()),
        };
        let mount = match mount_id(&base.join("fdinfo").join(name), self.end) {
            Ok(Some(mount)) => Some(mount),
            Ok(None) => {
                self.unknown(UnknownReference::FdMountMetadata)?;
                None
            }
            Err(error) if vanished(&error) => return Ok(()),
            Err(error) if denied(&error) => {
                self.unknown(UnknownReference::FdMountMetadata)?;
                None
            }
            Err(error) => return Err(error),
        };
        if let Some(info) = &held
            && info.mode() & libc::S_IFMT == libc::S_IFSOCK
        {
            sockets.insert(UnsignedInteger::from_u64(info.ino()));
        }
        if self.matches(held.as_ref(), link.as_ref(), mount.as_ref())? {
            self.known(KnownReference::Fd)?;
        }
        Ok(())
    }
}
fn mount_id(path: &Path, end: Instant) -> Result<Option<UnsignedInteger>> {
    check(end)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)?;
    let mut reader = BufReader::new(file);
    let result = (|| {
        let mut header = ReferenceFdHeader::default();
        let mut line = Vec::new();
        for _ in 0..16 {
            check(end)?;
            line.clear();
            if Read::take(&mut reader, 4097).read_until(b'\n', &mut line)? == 0 {
                break;
            }
            if let Some(mount) = header.push(&line)? {
                return Ok(Some(mount));
            }
        }
        Ok(None)
    })();
    finalized(result, fs::close(reader.into_inner()))
}
