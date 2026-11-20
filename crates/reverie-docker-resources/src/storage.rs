use crate::{
    args::decimal,
    data,
    error::{Result, need},
    files::Files,
};
use serde::Serialize;
use std::{io::Write, os::unix::fs::MetadataExt, str::FromStr};

#[derive(Clone, Serialize, PartialEq, Eq, Debug)]
pub(crate) struct Directory {
    dev: String,
    ino: String,
    uid: u32,
    gid: u32,
    mode: u32,
}
impl FromStr for Directory {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        let invalid = || "expected DEV:INO:UID:GID:MODE in canonical decimal".to_owned();
        let [dev, ino, uid, gid, mode] = value
            .splitn(6, ':')
            .collect::<Vec<_>>()
            .try_into()
            .map_err(|_| invalid())?;
        decimal(dev)?;
        if decimal(ino)? == 0 {
            return Err("directory inode must be nonzero".into());
        }
        let uid = u32::try_from(decimal(uid)?).map_err(|_| invalid())?;
        let gid = u32::try_from(decimal(gid)?).map_err(|_| invalid())?;
        let mode = u32::try_from(decimal(mode)?).map_err(|_| invalid())?;
        if mode > 0o7777 {
            return Err("directory mode exceeds permission and special bits".into());
        }
        Ok(Self {
            dev: dev.into(),
            ino: ino.into(),
            uid,
            gid,
            mode,
        })
    }
}
fn directory(files: &Files, index: usize) -> Result<Directory> {
    let m = files.get(index).metadata()?;
    Ok(Directory {
        dev: m.dev().to_string(),
        ino: m.ino().to_string(),
        uid: m.uid(),
        gid: m.gid(),
        mode: m.mode() & 0o7777,
    })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Storage {
    version: u8,
    purpose: &'static str,
    holder_start_ticks: Option<String>,
    home: Directory,
    nix: Directory,
}
fn birth(files: &mut Files) -> Result<u64> {
    data::process_stat(&files.init_stat()?, 1)
}
fn encode(value: &Storage) -> Result<String> {
    serde_json::to_string(value)
        .map_err(std::io::Error::other)
        .map_err(Into::into)
}
fn observation(files: &Files, home: usize, nix: usize, start: Option<u64>) -> Result<Storage> {
    Ok(Storage {
        version: 1,
        purpose: "reverie-boxed-storage-observation-v1",
        holder_start_ticks: start.map(|v| v.to_string()),
        home: directory(files, home)?,
        nix: directory(files, nix)?,
    })
}
fn reference_mounts(files: &mut Files) -> Result<(usize, usize)> {
    let home = files.storage("/run/reverie-worker-home", true)?;
    let nix = files.storage("/run/reverie-worker-nix", true)?;
    Ok((home, nix))
}
pub(crate) fn probe(files: &mut Files) -> Result<String> {
    let home = files.storage("/home/agent", false)?;
    let nix = files.storage("/nix", false)?;
    encode(&observation(files, home, nix, None)?)
}
fn compared_reference(
    mut observed: Storage,
    expected_home: &Directory,
    expected_nix: &Directory,
) -> Result<Storage> {
    need(
        &observed.home == expected_home && &observed.nix == expected_nix,
        "BOXED_STORAGE_REFERENCE_CHANGED",
    )?;
    observed.purpose = "reverie-boxed-storage-reference-v1";
    Ok(observed)
}
fn verify_filesystem(files: &Files, index: usize, expected: u64) -> Result<()> {
    let directory = files.get(index);
    let metadata = nix::sys::statfs::fstatfs(directory).map_err(std::io::Error::from)?;
    let volume = rustix::fs::fstatvfs(directory).map_err(std::io::Error::from)?;
    need(
        expected != 0
            && metadata.filesystem_type() == nix::sys::statfs::EXT4_SUPER_MAGIC
            && volume.f_fsid == expected,
        "BOXED_STORAGE_FILESYSTEM_CHANGED",
    )
}

pub(crate) fn verify_reference(
    files: &mut Files,
    home: &Directory,
    nix: &Directory,
    filesystem_id: Option<u64>,
) -> Result<String> {
    let (home_fd, nix_fd) = reference_mounts(files)?;
    if let Some(expected) = filesystem_id {
        verify_filesystem(files, home_fd, expected)?;
        verify_filesystem(files, nix_fd, expected)?;
    }
    let checked = compared_reference(observation(files, home_fd, nix_fd, None)?, home, nix)?;
    encode(&checked)
}
pub(crate) fn status(files: &mut Files, expected: u64) -> Result<String> {
    let before = birth(files)?;
    need(
        expected > 0 && before == expected,
        "BOXED_STORAGE_HOLDER_CHANGED",
    )?;
    let (home, nix) = reference_mounts(files)?;
    let output = encode(&observation(files, home, nix, Some(before))?)?;
    need(birth(files)? == before, "BOXED_STORAGE_HOLDER_CHANGED")?;
    Ok(output)
}
pub(crate) fn hold(files: &mut Files) -> Result<()> {
    need(std::process::id() == 1, "BOXED_STORAGE_HOLDER_NOT_INIT")?;
    let start = birth(files)?;
    let (home, nix) = reference_mounts(files)?;
    let output = encode(&observation(files, home, nix, Some(start))?)?;
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{output}")?;
    stdout.flush()?;
    drop(stdout);
    loop {
        std::thread::park();
    }
}

#[cfg(test)]
mod tests;
