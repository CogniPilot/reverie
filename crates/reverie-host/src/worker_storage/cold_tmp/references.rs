//! Strict destructive-clear same-real-UID inode inventory. Permission gaps
//! refuse. Only a vanished process makes incomplete per-PID reads benign.
use super::*;
use reverie_contracts::kernel_accounting;
use std::{ffi::OsStr, io};
pub(super) fn strict(keys: &BTreeSet<Key>, ignored: i32, end: Instant) -> Result<()> {
    observe(
        Path::new("/proc"),
        keys,
        ignored,
        native::uid(),
        std::process::id(),
        end,
    )
}
fn directory_names(path: &Path, end: Instant) -> Result<Vec<OsString>> {
    let file = native::open_at(
        libc::AT_FDCWD,
        path.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    finalized(raw_names(&file, usize::MAX, end), fs::close(file))
}
fn text(path: &Path, end: Instant) -> Result<String> {
    check(end)?;
    let raw = native::read_reservation(path, 65536)?;
    String::from_utf8(raw).map_err(|_| StorageError::Refused(StorageFault::ColdReference))
}
fn identity(base: &Path, end: Instant) -> Result<(String, String)> {
    let text = text(&base.join("stat"), end)?;
    let (_, tail) = text
        .rsplit_once(')')
        .ok_or(StorageError::Refused(StorageFault::ColdReference))?;
    let fields = kernel_accounting::words(tail);
    need(fields.len() > 19, StorageFault::ColdReference)?;
    Ok((fields[0].to_owned(), fields[19].to_owned()))
}
fn credentials(base: &Path, uid: u32, end: Instant) -> Result<bool> {
    check(end)?;
    let raw = native::read_reservation(&base.join("status"), 65536)?;
    let rows = raw
        .split(|byte| *byte == b'\n')
        .filter(|line| line.starts_with(b"Uid:"))
        .collect::<Vec<_>>();
    need(rows.len() == 1, StorageFault::ColdReference)?;
    let fields = rows[0]
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty())
        .skip(1)
        .collect::<Vec<_>>();
    need(fields.len() == 4, StorageFault::ColdReference)?;
    let mut owned = false;
    for value in fields {
        let text = std::str::from_utf8(value)
            .map_err(|_| StorageError::Refused(StorageFault::ColdReference))?;
        need(
            !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()),
            StorageFault::ColdReference,
        )?;
        let value = text
            .parse::<u32>()
            .map_err(|_| StorageError::Refused(StorageFault::ColdReference))?;
        owned |= value == uid;
    }
    Ok(owned)
}
fn not_referenced(path: &Path, keys: &BTreeSet<Key>) -> Result<()> {
    match std::fs::metadata(path) {
        Ok(info) => need(
            !keys.contains(&(info.dev(), info.ino())),
            StorageFault::ColdReference,
        ),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
fn maps(base: &Path, keys: &BTreeSet<Key>, end: Instant) -> Result<()> {
    check(end)?;
    let raw = native::read_reservation(&base.join("maps"), 4 << 20)?;
    for line in raw
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        check(end)?;
        let fields = line
            .split(|byte| byte.is_ascii_whitespace())
            .filter(|field| !field.is_empty())
            .take(5)
            .collect::<Vec<_>>();
        need(fields.len() == 5, StorageFault::ColdReference)?;
        let device = std::str::from_utf8(fields[3])
            .map_err(|_| StorageError::Refused(StorageFault::ColdReference))?;
        let (major, minor) = device
            .split_once(':')
            .ok_or(StorageError::Refused(StorageFault::ColdReference))?;
        let parse = |text: &str, radix| {
            u64::from_str_radix(text, radix)
                .map_err(|_| StorageError::Refused(StorageFault::ColdReference))
        };
        let device = nix::sys::stat::makedev(parse(major, 16)?, parse(minor, 16)?);
        let inode = parse(
            std::str::from_utf8(fields[4])
                .map_err(|_| StorageError::Refused(StorageFault::ColdReference))?,
            10,
        )?;
        need(
            !keys.contains(&(device, inode)),
            StorageFault::ColdReference,
        )?;
    }
    Ok(())
}
fn process(
    base: &Path,
    pid: u32,
    keys: &BTreeSet<Key>,
    ignored: i32,
    uid: u32,
    me: u32,
    end: Instant,
) -> Result<()> {
    if !credentials(base, uid, end)? {
        return Ok(());
    }
    let before = identity(base, end)?;
    if ["Z", "X"].contains(&before.0.as_str()) {
        return Ok(());
    }
    for name in directory_names(&base.join("fd"), end)? {
        check(end)?;
        if pid == me && name == OsStr::new(&ignored.to_string()) {
            continue;
        }
        not_referenced(&base.join("fd").join(name), keys)?;
    }
    for name in ["cwd", "root", "exe"] {
        check(end)?;
        not_referenced(&base.join(name), keys)?;
    }
    maps(base, keys, end)?;
    need(
        identity(base, end)?.1 == before.1,
        StorageFault::ColdReference,
    )
}
fn observe(
    proc: &Path,
    keys: &BTreeSet<Key>,
    ignored: i32,
    uid: u32,
    me: u32,
    end: Instant,
) -> Result<()> {
    for name in directory_names(proc, end)? {
        check(end)?;
        let Some(text) = name.to_str() else {
            continue;
        };
        if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let pid = text
            .parse::<u32>()
            .map_err(|_| StorageError::Refused(StorageFault::ColdReference))?;
        let base = proc.join(name);
        if let Err(error) = process(&base, pid, keys, ignored, uid, me, end) {
            let vanished = matches!(&error,StorageError::Io(error) if error.kind()==io::ErrorKind::NotFound||error.raw_os_error()==Some(libc::ESRCH));
            if !vanished || base.try_exists()? {
                return Err(error);
            }
        }
    }
    check(end)
}
#[cfg(test)]
mod tests;
