//! Verify the existing model cache and publish new downloads atomically.
use crate::Result;
use nix::fcntl::{Flock, FlockArg};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Read},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const LIMIT: u64 = 400 * 1024 * 1024;
pub(super) const MODEL: &str = "kokoro-v1.0.onnx";
pub(super) const VOICES: &str = "voices-v1.0.bin";

#[derive(serde::Deserialize)]
struct Asset {
    url: String,
    sha256: String,
}

#[derive(serde::Deserialize)]
struct Pins {
    model: Asset,
    voices: Asset,
}

fn pins() -> Result<Pins> {
    Ok(serde_json::from_str(include_str!("../model-files.json"))?)
}

pub(super) fn verify_files(model: &Path, voices: &Path) -> Result<()> {
    let pins = pins()?;
    verify(model, &pins.model.sha256)?;
    verify(voices, &pins.voices.sha256)
}

pub(super) fn ensure(directory: &Path) -> Result<()> {
    DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(directory)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(directory.join(".download.lock"))?;
    if !lock.metadata()?.is_file() {
        return Err("Invalid model download lock".into());
    }
    let _guard = Flock::lock(lock, FlockArg::LockExclusive).map_err(|(_, error)| error)?;
    let pins = pins()?;
    for (name, asset) in [(MODEL, pins.model), (VOICES, pins.voices)] {
        let target = directory.join(name);
        match target.symlink_metadata() {
            Ok(_) => verify(&target, &asset.sha256)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                download(directory, name, &asset)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn verify(path: &Path, expected: &str) -> Result<()> {
    // Existing caches can contain symlinks into immutable, hash-checked Nix
    // assets. Nonregular devices and failed checks never reach the engine.
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(path)?;
    let info = file.metadata()?;
    if !info.is_file() || info.len() > LIMIT {
        return Err("Invalid Kokoro asset size or file type".into());
    }
    let mut hash = Sha256::new();
    if io::copy(&mut file.by_ref().take(LIMIT + 1), &mut hash)? > LIMIT
        || format!("{:x}", hash.finalize()) != expected
    {
        return Err(format!("Model checksum mismatch: {}", path.display()).into());
    }
    Ok(())
}

struct Part(PathBuf);
impl Drop for Part {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn download(directory: &Path, name: &str, asset: &Asset) -> Result<()> {
    let path = directory.join(format!("{name}.part"));
    // The held cache lock makes this name specific to a previous interrupted
    // download. Removing a possible link never touches its target.
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    let part = Part(path);
    eprintln!("Downloading {name}");
    let status = Command::new(option_env!("REVERIE_KOKORO_CURL").unwrap_or("curl"))
        .args([
            "--disable",
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--max-time",
            "60",
            "--max-filesize",
        ])
        .arg(LIMIT.to_string())
        .arg(&asset.url)
        .stdin(Stdio::null())
        .stdout(file.try_clone()?)
        .status()?;
    if !status.success() {
        return Err(format!("Model download failed: {name}").into());
    }
    file.sync_all()?;
    verify(&part.0, &asset.sha256)?;
    fs::hard_link(&part.0, directory.join(name))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}
