//! No old-tree walk: bounded same-real-UID proc observations with explicit
//! UNKNOWN records. A successful report never proves absence of all holders.
use super::super::*;
use crate::reservation_kernel::ReservationKernel;
use reverie_contracts::{
    kernel_mounts::{MountDevice, MountTable},
    worker_cold_tmp::{
        KnownReference, ReferenceKind, ReferenceLink, ReferenceProcessIdentity, ReferenceReport,
        UnknownReference, reference_credentials,
    },
};
use reverie_core::decimal::UnsignedInteger;
use std::{ffi::OsStr, io};
mod coordinates;
use coordinates::IndexedMounts;
mod fd;
mod process;
mod rows;
#[cfg(test)]
mod tests;
struct Target {
    path: PosixPath,
    key: Key,
    coordinate: (MountDevice, PosixPath),
}
struct Observer<'a> {
    target: &'a Target,
    report: &'a mut ReferenceReport,
    pid: u32,
    table: Option<IndexedMounts>,
    end: Instant,
}
impl Observer<'_> {
    fn known(&mut self, kind: KnownReference) -> Result<()> {
        self.report.record(self.pid, ReferenceKind::Known(kind))?;
        Ok(())
    }
    fn unknown(&mut self, kind: UnknownReference) -> Result<()> {
        self.report.record(self.pid, ReferenceKind::Unknown(kind))?;
        Ok(())
    }
}
fn read(path: &Path, maximum: usize, end: Instant) -> Result<Vec<u8>> {
    check(end)?;
    let raw = native::read_reservation(path, maximum)?;
    check(end)?;
    Ok(raw)
}
fn identity(base: &Path, end: Instant) -> Result<ReferenceProcessIdentity> {
    let raw = read(&base.join("stat"), 65536, end)?;
    let text = std::str::from_utf8(&raw)
        .map_err(|_| StorageError::Refused(StorageFault::ColdReference))?;
    Ok(ReferenceProcessIdentity::parse(text)?)
}
fn directory_names(path: &Path, maximum: usize, end: Instant) -> Result<Vec<OsString>> {
    check(end)?;
    let file = native::open_at(
        libc::AT_FDCWD,
        path.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    finalized(raw_names(&file, maximum, end), fs::close(file))
}
fn vanished(error: &StorageError) -> bool {
    matches!(error,StorageError::Io(error) if error.kind()==io::ErrorKind::NotFound || error.raw_os_error()==Some(libc::ESRCH))
}
fn denied(error: &StorageError) -> bool {
    matches!(error,StorageError::Io(error) if error.kind()==io::ErrorKind::PermissionDenied)
}
pub(super) fn collect(target: &PosixPath, ignored: i32, end: Instant) -> Result<ReferenceReport> {
    observe(Path::new("/proc"), target, ignored, end)
}
fn observe(proc: &Path, target: &PosixPath, ignored: i32, end: Instant) -> Result<ReferenceReport> {
    check(end)?;
    let info = std::fs::metadata(native::python_path(&target.codepoints())?)?;
    let kernel = ReservationKernel::new();
    let table = kernel
        .mount_table(end)
        .map_err(|error| StorageError::ColdKernel(Box::new(error)))?;
    let coordinate = kernel
        .cold_reference_location(target, &table, end)
        .map_err(|error| StorageError::ColdKernel(Box::new(error)))?;
    let target = Target {
        path: target.clone(),
        key: (info.dev(), info.ino()),
        coordinate,
    };
    let mut names = directory_names(proc, usize::MAX, end)?
        .into_iter()
        .filter_map(|name| {
            let text = name.to_str()?;
            (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())).then_some(name)
        })
        .collect::<Vec<_>>();
    need(names.len() <= 16384, StorageFault::ColdBound)?;
    names.sort_by_key(|name| {
        UnsignedInteger::parse(name.to_str().expect("ASCII proc name")).expect("decimal proc name")
    });
    let mut report = ReferenceReport::default();
    for name in names {
        check(end)?;
        let pid = name
            .to_str()
            .expect("ASCII proc name")
            .parse::<u32>()
            .map_err(|_| StorageError::Refused(StorageFault::ColdReference))?;
        process::visit(proc.join(name), pid, &target, &mut report, ignored, end)?;
    }
    check(end)?;
    let current = std::fs::metadata(native::python_path(&target.path.codepoints())?)?;
    need(
        (current.dev(), current.ino()) == target.key,
        StorageFault::ColdReference,
    )?;
    Ok(report)
}
