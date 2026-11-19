use crate::Result;
use nix::libc;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::Command;

pub(super) struct Scratch(PathBuf);

impl Scratch {
    pub(super) fn create(root: &Path) -> Result<Self> {
        Ok(Self(nix::unistd::mkdtemp(&root.join("speech-XXXXXX"))?))
    }

    pub(super) fn file(&self, leaf: &str) -> PathBuf {
        self.0.join(leaf)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn read(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let info = file.metadata()?;
    if !info.is_file() || info.len() > limit as u64 {
        return Err("speech file is not a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err("speech file exceeded its bound".into());
    }
    Ok(bytes)
}

pub(super) fn asset(path: &Path, bound: u64) -> bool {
    fs::symlink_metadata(path).is_ok_and(|info| info.is_file() && (1..=bound).contains(&info.len()))
}

pub(super) fn executable(program: PathBuf) -> PathBuf {
    let selected = if program.components().count() == 1 {
        search(program)
    } else {
        program
    };
    std::path::absolute(&selected).unwrap_or(selected)
}

fn search(program: PathBuf) -> PathBuf {
    let paths = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&paths)
        .map(|directory| directory.join(&program))
        .find(|path| path.is_file())
        .unwrap_or(program)
}

pub(super) fn command(program: &Path, output: &Path) -> Command {
    let mut command = Command::new(program);
    if let Some(parent) = output.parent() {
        command.current_dir(parent);
    }
    // Commands are owner-selected or package-pinned, never chosen by a request.
    command
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command
}

pub(super) async fn run(mut command: Command, failure: &'static str) -> Result<()> {
    if command.status().await?.success() {
        Ok(())
    } else {
        Err(failure.into())
    }
}

pub(super) fn stdin(command: &mut Command, path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::write(path, bytes)?;
    command.stdin(File::open(path)?);
    Ok(())
}
