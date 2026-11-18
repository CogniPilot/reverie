use super::setting;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use nix::fcntl::{Flock, FlockArg};
use nix::libc;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

pub(super) struct Instance {
    data: PathBuf,
    console: PathBuf,
    username: OsString,
    password: OsString,
}

impl Instance {
    pub(super) fn prepare(data: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&data)?;
        // Serialize preparation on a shared volume without a lock file that a
        // restart could mistake for stale state. The lock ends before launch.
        let directory = File::open(&data)?;
        let _lock = Flock::lock(directory, FlockArg::LockExclusive)
            .map_err(|(_, error)| io::Error::from(error))?;
        let console = PathBuf::from(setting("REVERIE_DATA_DIR", data.join("console")));
        for path in [
            data.join("console"),
            data.join("backups"),
            data.join("tools"),
            data.join("accounts/claude"),
            data.join("accounts/codex"),
            PathBuf::from(setting("TMPDIR", "/tmp")),
            console.clone(),
        ] {
            fs::create_dir_all(path)?;
        }
        prepare_version(&data)?;
        let mut password = setting("REVERIE_PASSWORD", "");
        if password.is_empty() {
            password = credential(&data.join("owner-password"))?;
        }
        let username = setting("REVERIE_USERNAME", "owner");
        atomic_write(&console.join(".env"), |file| {
            file.write_all(b"REVERIE_USERNAME=")?;
            file.write_all(username.as_bytes())?;
            file.write_all(b"\nREVERIE_PASSWORD=")?;
            file.write_all(password.as_bytes())?;
            file.write_all(b"\n")
        })?;
        // The backend owns the account and its policy marker.
        Ok(Self {
            data,
            console,
            username,
            password,
        })
    }

    pub(super) fn data(&self) -> &Path {
        &self.data
    }

    pub(super) fn configure(&self, command: &mut Command, path: &OsStr) {
        command
            .env("REVERIE_DATA", &self.data)
            .env("REVERIE_DATA_DIR", &self.console)
            .env("REVERIE_USERNAME", &self.username)
            .env("REVERIE_PASSWORD", &self.password)
            .env("REVERIE_OWNER_SETUP", "1")
            .env(
                "CLAUDE_CONFIG_DIR",
                setting("CLAUDE_CONFIG_DIR", self.data.join("accounts/claude")),
            )
            .env(
                "CODEX_HOME",
                setting("CODEX_HOME", self.data.join("accounts/codex")),
            )
            .env("PATH", path);
    }
}

fn read_value(path: &Path) -> io::Result<Vec<u8>> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    if !file.metadata()?.is_file() {
        return Err(io::Error::other(
            "office bootstrap state must be a regular file",
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    while bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    Ok(bytes)
}

fn credential(path: &Path) -> io::Result<OsString> {
    let existing = read_value(path)?;
    if !existing.is_empty() {
        return Ok(OsString::from_vec(existing));
    }
    let generated = random_token::<18>()?;
    atomic_write(path, |file| writeln!(file, "{generated}"))?;
    eprintln!(
        "reverie-start: first start: internal runtime credential created; create your owner account in the browser"
    );
    Ok(generated.into())
}

fn random_token<const N: usize>() -> io::Result<String> {
    let mut random = [0; N];
    getrandom::getrandom(&mut random).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(random))
}

fn prepare_version(data: &Path) -> io::Result<()> {
    let marker = data.join(".image-version");
    let version = setting("REVERIE_VERSION", "dev");
    let previous = read_value(&marker)?;
    if !previous.is_empty() && previous != version.as_bytes() {
        backup(data, &previous)?;
    }
    if previous != version.as_bytes() {
        atomic_write(&marker, |file| {
            file.write_all(version.as_bytes())?;
            file.write_all(b"\n")
        })?;
    }
    Ok(())
}

fn backup(data: &Path, previous: &[u8]) -> io::Result<()> {
    let label: String = String::from_utf8_lossy(previous)
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || "._-".contains(ch) {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let timestamp = DateTime::<Utc>::from(SystemTime::now()).format("%Y%m%dT%H%M%SZ");
    let destination = data
        .join("backups")
        .join(format!("console-{label}-{timestamp}.tar"));
    atomic_write(&destination, |file| {
        let status = Command::new("tar")
            .arg("-C")
            .arg(data)
            .args(["-cf", "-", "console"])
            .stdout(Stdio::from(file.try_clone()?))
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "console backup failed ({status})"
            )))
        }
    })?;
    eprintln!(
        "reverie-start: previous console state backed up to {}",
        destination.display()
    );
    Ok(())
}

fn atomic_write(path: &Path, write: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing bootstrap state parent"))?;
    let temporary = parent.join(format!(".reverie-start-{}", random_token::<12>()?));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)?;
    let published = write(&mut file)
        .and_then(|()| file.sync_all())
        .and_then(|()| fs::rename(&temporary, path));
    if published.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    published?;
    File::open(parent)?.sync_all()
}
