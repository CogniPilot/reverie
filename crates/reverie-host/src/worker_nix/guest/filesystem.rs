use super::{Bootstrap, Result};
use std::{
    fs,
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::{PermissionsExt, symlink},
    },
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);

pub(super) fn prepare(bootstrap: &Bootstrap) -> Result<()> {
    if !bootstrap.target.is_dir() {
        return Err(std::io::ErrorKind::NotADirectory.into());
    }
    fs::create_dir_all(bootstrap.temporary.join("nix-bootstrap-home"))?;
    fs::create_dir_all(bootstrap.temporary.join("nix-bootstrap-state"))?;
    Ok(())
}
pub(super) fn freeze_database(bootstrap: &Bootstrap) -> Result<()> {
    let path = bootstrap.temporary.join("nix-bootstrap-state/db/db.sqlite");
    let mode = fs::metadata(&path)?.permissions().mode();
    fs::set_permissions(path, fs::Permissions::from_mode(mode & !0o222))?;
    Ok(())
}
pub(super) fn publish_root(bootstrap: &Bootstrap) -> Result<()> {
    let parent = bootstrap.target.join("var/nix/gcroots");
    fs::create_dir_all(&parent)?;
    let mut target = fs::read_link(&bootstrap.base)?
        .as_os_str()
        .as_bytes()
        .to_vec();
    // Bash command substitution strips all trailing LF bytes from readlink's
    // output; its terminating LF and any LF suffix in the link are removed.
    while target.last() == Some(&b'\n') {
        target.pop();
    }
    let target = std::path::PathBuf::from(std::ffi::OsString::from_vec(target));
    let mut destination = parent.join("reverie-image");
    if fs::symlink_metadata(&destination).is_ok_and(|entry| entry.is_dir()) {
        destination.push(target.file_name().ok_or(std::io::ErrorKind::InvalidInput)?);
    }
    match symlink(&target, &destination) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let temporary = destination
        .parent()
        .ok_or(std::io::ErrorKind::InvalidInput)?
        .join(format!(
            ".reverie-image-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    symlink(&target, &temporary)?;
    // Atomic replacement retains an existing regular/link inode's bytes. A
    // failure never unlinks a named temporary: it may have been rebound, and
    // retained evidence is preferable to deleting another writer's entry.
    fs::rename(&temporary, &destination)?;
    Ok(())
}
