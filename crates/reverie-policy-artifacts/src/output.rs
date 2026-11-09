//! Build-owned exclusive output leaves, with one checked close per descriptor.
#![allow(unsafe_code)]
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::IntoRawFd;
use std::path::Path;

pub(super) fn read_bounded(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    let limit = maximum.checked_add(1).ok_or(io::ErrorKind::InvalidInput)?;
    let result = (&mut file)
        .take(limit as u64)
        .read_to_end(&mut bytes)
        .map(|_| bytes);
    finalized(result, close(file))
}

pub(super) fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let result = file.write_all(bytes).and_then(|()| file.flush());
    finalized(result, close(file))
}

pub(super) fn write_new_pair(
    profile: &Path,
    profile_bytes: &[u8],
    manifest: &Path,
    manifest_bytes: &[u8],
) -> io::Result<()> {
    let mut profile = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(profile)?;
    let mut manifest = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(manifest)
    {
        Ok(file) => file,
        Err(error) => return finalized(Err(error), close(profile)),
    };
    let result = profile
        .write_all(profile_bytes)
        .and_then(|()| manifest.write_all(manifest_bytes))
        .and_then(|()| profile.flush())
        .and_then(|()| manifest.flush());
    let result = finalized(result, close(profile));
    finalized(result, close(manifest))
}
fn finalized<T>(primary: io::Result<T>, close: io::Result<()>) -> io::Result<T> {
    match (primary, close) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(close)) => Err(io::Error::other(format!(
            "{primary}; output close failed: {close}"
        ))),
    }
}
pub(super) fn close(file: File) -> io::Result<()> {
    let descriptor = file.into_raw_fd();
    // SAFETY: sole File ownership was consumed. Close this owned descriptor
    // exactly once; retrying after EINTR could close an unrelated reused fd.
    let result = if unsafe { libc::close(descriptor) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    };
    #[cfg(test)]
    let result = finalized(result, tests::after_close());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    thread_local! {static FAIL_NTH:Cell<usize>=const{Cell::new(0)};}
    pub(super) fn after_close() -> io::Result<()> {
        if FAIL_NTH.with(|nth| {
            let current = nth.get();
            nth.set(current.saturating_sub(1));
            current == 1
        }) {
            Err(io::Error::other("injected real-close failure"))
        } else {
            Ok(())
        }
    }
    #[test]
    fn actual_read_and_each_output_close_failure_refuse_without_retry() {
        let root = std::env::temp_dir().join(format!(
            "reverie-artifact-close-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let base = root.join("base");
        std::fs::write(&base, b"base").unwrap();
        FAIL_NTH.with(|nth| nth.set(1));
        assert!(read_bounded(&base, 4).is_err());
        assert_eq!(read_bounded(&base, 4).unwrap(), b"base");
        FAIL_NTH.with(|value| value.set(1));
        assert!(write_new(&root.join("docker-profile"), b"profile").is_err());
        assert_eq!(FAIL_NTH.with(Cell::get), 0);
        for nth in [1, 2] {
            FAIL_NTH.with(|value| value.set(nth));
            assert!(
                write_new_pair(
                    &root.join(format!("profile{nth}")),
                    b"profile",
                    &root.join(format!("manifest{nth}")),
                    b"manifest"
                )
                .is_err()
            );
            assert_eq!(FAIL_NTH.with(Cell::get), 0);
        }
        FAIL_NTH.with(|value| value.set(1));
        let error =
            write_new_pair(&root.join("profile"), b"profile", &base, b"retained").unwrap_err();
        assert!(error.to_string().contains("File exists"));
        assert!(error.to_string().contains("close failure"));
        assert_eq!(std::fs::read(base).unwrap(), b"base");
        std::fs::remove_dir_all(root).unwrap();
    }
}
