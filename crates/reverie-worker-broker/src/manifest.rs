//! Build-only, fixed-slot exclusive publication. No caller path/program, no
//! runtime identity grant, and no replacement/overwrite/retry of partial output.
use reverie_contracts::worker_pool::BrokerProgramData;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions, Permissions},
    io::{self, Read, Write},
    os::{
        fd::IntoRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::Path,
};
const MAXIMUM: u64 = 256 * 1024 * 1024;
pub(super) fn publish() -> io::Result<()> {
    let executable = option_env!("REVERIE_FIXED_NATIVE_WORKER_BROKER_EXECUTABLE")
        .ok_or_else(|| io::Error::other("NATIVE_BROKER_BUILD_SLOT_REQUIRED"))?;
    let destination = option_env!("REVERIE_FIXED_NATIVE_WORKER_BROKER_MANIFEST")
        .ok_or_else(|| io::Error::other("NATIVE_BROKER_BUILD_SLOT_REQUIRED"))?;
    let path = Path::new(executable);
    let parent = path
        .parent()
        .and_then(Path::parent)
        .ok_or(io::ErrorKind::InvalidInput)?;
    if Path::new(destination) != parent.join("share/reverie/worker-broker-program.json")
        || std::env::current_exe()? != path
    {
        return Err(io::Error::other("NATIVE_BROKER_BUILD_SLOT_CHANGED"));
    }
    let bytes = program(path)?;
    let body = serde_json::to_vec(&serde_json::json!({
        "version": 1, "purpose": "reverie-native-worker-broker-v1", "executable": executable,
        "executableSHA256": format!("{:x}", Sha256::digest(&bytes)), "bytes": bytes.len()
    }))?;
    BrokerProgramData::decode(&body)
        .map_err(|_| io::Error::other("NATIVE_BROKER_MANIFEST_INVALID"))?;
    write(Path::new(destination), &body)
}
fn open(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
        .open(path)
}
fn program(path: &Path) -> io::Result<Vec<u8>> {
    let mut file = open(path)?;
    let result = (|| {
        let before = file.metadata()?;
        if !before.is_file() || before.len() == 0 || before.len() > MAXIMUM {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut bytes = Vec::new();
        (&mut file).take(MAXIMUM + 1).read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.mtime() != after.mtime()
            || before.ctime_nsec() != after.ctime_nsec()
            || before.ctime() != after.ctime()
            || bytes.len() as u64 != before.len()
            || !bytes.starts_with(b"\x7fELF")
        {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(bytes)
    })();
    finalized(result, close(file))
}
fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW | nix::libc::O_DIRECTORY)
        .open(path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
    let result = write_leaf(path, bytes).and_then(|()| directory.sync_all());
    finalized(result, close(directory))
}
fn write_leaf(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o444)
        .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NOFOLLOW)
        .open(path)?;
    let result = file
        .set_permissions(Permissions::from_mode(0o444))
        .and_then(|()| file.write_all(bytes))
        .and_then(|()| file.sync_all());
    finalized(result, close(file))?;
    let mut readback = open(path)?;
    let result = (|| {
        let mut actual = Vec::new();
        (&mut readback).take(8193).read_to_end(&mut actual)?;
        if actual != bytes {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(())
    })();
    finalized(result, close(readback))
}
fn close(file: File) -> io::Result<()> {
    // Consume the sole File exactly once; never retry a consumed close.
    nix::unistd::close(file.into_raw_fd()).map_err(io::Error::from)
}
fn finalized<T>(primary: io::Result<T>, closed: io::Result<()>) -> io::Result<T> {
    match (primary, closed) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(closed)) => Err(io::Error::other(format!(
            "{primary}; checked close: {closed}"
        ))),
    }
}
pub(super) fn publish_service_unit() -> io::Result<()> {
    let executable = option_env!("REVERIE_FIXED_NATIVE_WORKER_BROKER_EXECUTABLE")
        .ok_or_else(|| io::Error::other("NATIVE_SERVICE_BUILD_SLOT_REQUIRED"))?;
    let target = option_env!("REVERIE_FIXED_NATIVE_WORKER_SERVICE_UNIT")
        .ok_or_else(|| io::Error::other("NATIVE_SERVICE_BUILD_SLOT_REQUIRED"))?;
    let expected = Path::new(executable)
        .parent()
        .and_then(Path::parent)
        .ok_or(io::ErrorKind::InvalidInput)?
        .join("share/systemd/user/reverie-worker-broker.service");
    if Path::new(target) != expected || std::env::current_exe()? != Path::new(executable) {
        return Err(io::Error::other("NATIVE_SERVICE_BUILD_SLOT_CHANGED"));
    }
    let body = format!(
        "[Unit]\nDescription=Reverie native worker broker\n[Service]\nEnvironmentFile=%h/reverie/worker-pool/service/environment\nExecStart={executable} broker --config ${{REVERIE_WORKER_CONFIG}}\nRestart=no\nTimeoutStopSec=35\nKillMode=mixed\nUMask=0077\nNoNewPrivileges=true\nMemoryMax=512M\nTasksMax=512\n[Install]\nWantedBy=default.target\n"
    );
    write(Path::new(target), body.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    #[test]
    fn actual_exclusive_manifest_publication_never_overwrites_the_original() {
        let root = std::env::temp_dir().join(format!(
            "broker-manifest-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("manifest");
        write(&path, b"original").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o444);
        assert!(write(&path, b"replacement").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn actual_current_native_elf_is_read_without_executing_another_program() {
        let bytes = program(&std::env::current_exe().unwrap()).unwrap();
        assert!(bytes.starts_with(b"\x7fELF"));
        assert!((1..=MAXIMUM).contains(&(bytes.len() as u64)));
    }
}
