use crate::{office::Office, refused};
use nix::{
    libc,
    unistd::{User, getuid},
};
use reverie_core::ids::ProfileSessionId;
use serde::Deserialize;
use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const CONFIG_BYTES: u64 = 65_536;

#[derive(Deserialize)]
pub(crate) struct Configuration {
    self_session_id: String,
    pub(crate) memory_instance: PathBuf,
    #[serde(flatten)]
    pub(crate) office: Office,
}

impl Configuration {
    pub(crate) fn capture() -> io::Result<Self> {
        if env::var("REVERIE_MUX").as_deref() != Ok("1") {
            return Err(refused());
        }
        let session = env::var("REVERIE_SESSION_ID").map_err(|_| refused())?;
        let session = ProfileSessionId::parse(&session).map_err(|_| refused())?;
        let path = path(&session)?;
        let value: Self = serde_json::from_slice(&read_private(&path)?)?;
        if value.self_session_id != session.as_str() || !value.memory_instance.is_absolute() {
            return Err(refused());
        }
        value.office.validate()?;
        Ok(value)
    }
}

fn chosen_path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn path(session: &ProfileSessionId) -> io::Result<PathBuf> {
    let root = if let Some(root) = chosen_path("REVERIE_DATA_DIR") {
        root
    } else {
        chosen_path("REVERIE_AGENT_HOME")
            .or_else(|| chosen_path("HOME"))
            .or_else(|| User::from_uid(getuid()).ok().flatten().map(|user| user.dir))
            .ok_or_else(refused)?
            .join(".reverie")
    };
    if !root.is_absolute() || fs::canonicalize(&root)?.as_os_str() != root.as_os_str() {
        return Err(refused());
    }
    let path = root.join("hands").join(session.as_str()).join("agent.json");
    if fs::canonicalize(&path)?.as_os_str() != path.as_os_str() {
        return Err(refused());
    }
    Ok(path)
}

fn read_private(path: &Path) -> io::Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != getuid().as_raw()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > CONFIG_BYTES
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.take(CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > CONFIG_BYTES {
        return Err(refused());
    }
    Ok(bytes)
}
