use super::Result;
use reverie_store::memory::MemoryStore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, File, OpenOptions, Permissions},
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) fn create(
    store: &MemoryStore,
    data: &Path,
    reason: &str,
    handoff: &str,
) -> Result<Value> {
    let root = data.join("archives");
    ensure_root(&root)?;
    let archive = reserve(&root)?;
    let before = fs::symlink_metadata(&archive)?;
    let prepared = write_archive(store, &archive, reason, handoff).and_then(|record| {
        File::open(&root)?.sync_all()?;
        File::open(data)?.sync_all()?;
        Ok(record)
    });
    if prepared.is_err()
        && fs::symlink_metadata(&archive).is_ok_and(|current| {
            current.is_dir() && (current.dev(), current.ino()) == (before.dev(), before.ino())
        })
    {
        // This attempt created this exact private directory and has not
        // touched lifecycle state yet.
        fs::remove_dir_all(archive)?;
    }
    prepared
}

fn ensure_root(path: &Path) -> Result<()> {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let info = fs::symlink_metadata(path)?;
            if !info.is_dir()
                || info.uid() != nix::unistd::getuid().as_raw()
                || info.mode() & 0o022 != 0
            {
                return Err("vacation archives need an owned directory".into());
            }
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn reserve(root: &Path) -> Result<PathBuf> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| io::Error::other("archive randomness unavailable"))?;
    let archive = root.join(format!("vacation-{:032x}", u128::from_be_bytes(bytes)));
    DirBuilder::new().mode(0o700).create(&archive)?;
    Ok(archive)
}

fn write_archive(
    store: &MemoryStore,
    archive: &Path,
    reason: &str,
    handoff: &str,
) -> Result<Value> {
    let db_path = archive.join("memory.sqlite");
    store.backup_to(&db_path)?;
    let mut database = File::open(db_path)?;
    let digest = sha256(&mut database)?;
    database.set_permissions(Permissions::from_mode(0o444))?;
    database.sync_all()?;
    let path = archive
        .to_str()
        .ok_or("vacation archive path requires Unicode text")?;
    let record = json!({
        "mode":"vacation", "reason":reason, "handoff":handoff, "archive":path,
        "created_at":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64(),
        "dreams_per_day":1, "dream_budget_seconds":120, "interim_admin":"the owner must appoint the interim admin",
        "database_sha256":digest,
    });
    let mut receipt = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(archive.join("handoff.json"))?;
    serde_json::to_writer_pretty(&mut receipt, &record)?;
    receipt.write_all(b"\n")?;
    receipt.set_permissions(Permissions::from_mode(0o444))?;
    receipt.sync_all()?;
    File::open(archive)?.sync_all()?;
    Ok(record)
}

fn sha256(file: &mut File) -> io::Result<String> {
    let mut hash = Sha256::new();
    let mut buffer = [0; 16384];
    loop {
        let size = file.read(&mut buffer)?;
        if size == 0 {
            return Ok(format!("{:x}", hash.finalize()));
        }
        hash.update(&buffer[..size]);
    }
}
