use crate::{
    data,
    error::{Result, need},
    files::Files,
};
use serde::Serialize;
use std::{io::Write, os::unix::fs::MetadataExt};

#[derive(Serialize, PartialEq, Debug)]
struct Directory {
    dev: String,
    ino: String,
    uid: u32,
    gid: u32,
    mode: u32,
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
fn encoded(files: &Files, home: usize, nix: usize, start: Option<u64>) -> Result<String> {
    serde_json::to_string(&Storage {
        version: 1,
        purpose: "reverie-boxed-storage-observation-v1",
        holder_start_ticks: start.map(|v| v.to_string()),
        home: directory(files, home)?,
        nix: directory(files, nix)?,
    })
    .map_err(std::io::Error::other)
    .map_err(Into::into)
}
pub(crate) fn probe(files: &mut Files) -> Result<String> {
    let home = files.storage("/home/agent", false)?;
    let nix = files.storage("/nix", false)?;
    encoded(files, home, nix, None)
}
pub(crate) fn status(files: &mut Files, expected: u64) -> Result<String> {
    let before = birth(files)?;
    need(
        expected > 0 && before == expected,
        "BOXED_STORAGE_HOLDER_CHANGED",
    )?;
    let home = files.storage("/run/reverie-worker-home", true)?;
    let nix = files.storage("/run/reverie-worker-nix", true)?;
    let output = encoded(files, home, nix, Some(before))?;
    need(birth(files)? == before, "BOXED_STORAGE_HOLDER_CHANGED")?;
    Ok(output)
}
pub(crate) fn hold(files: &mut Files) -> Result<()> {
    need(std::process::id() == 1, "BOXED_STORAGE_HOLDER_NOT_INIT")?;
    let start = birth(files)?;
    let home = files.storage("/run/reverie-worker-home", true)?;
    let nix = files.storage("/run/reverie-worker-nix", true)?;
    let output = encoded(files, home, nix, Some(start))?;
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{output}")?;
    stdout.flush()?;
    drop(stdout);
    loop {
        std::thread::park();
    }
}
