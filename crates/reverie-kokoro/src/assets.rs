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

const RELEASE: &str =
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";
const LIMIT: u64 = 400 * 1024 * 1024;
pub(super) const MODEL: &str = "kokoro-v1.0.onnx";
pub(super) const VOICES: &str = "voices-v1.0.bin";
const ASSETS: [(&str, &str); 2] = [
    (
        MODEL,
        "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    ),
    (
        VOICES,
        "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    ),
];

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
    for (name, digest) in ASSETS {
        let target = directory.join(name);
        match target.symlink_metadata() {
            Ok(_) => verify(&target, digest)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                download(directory, name, digest)?;
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

fn download(directory: &Path, name: &str, digest: &str) -> Result<()> {
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
        .arg(format!("{RELEASE}/{name}"))
        .stdin(Stdio::null())
        .stdout(file.try_clone()?)
        .status()?;
    if !status.success() {
        return Err(format!("Model download failed: {name}").into());
    }
    file.sync_all()?;
    verify(&part.0, digest)?;
    fs::hard_link(&part.0, directory.join(name))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}
