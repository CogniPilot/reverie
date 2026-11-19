use reverie_core::ids::NativeOperationId;
use serde::Serialize;
use serde_json::value::RawValue;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

#[derive(Serialize)]
pub(crate) struct Loaded {
    present: bool,
    pub(crate) value: Option<Box<RawValue>>,
}

pub(crate) fn load(path: &Path) -> io::Result<Loaded> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(Loaded {
                present: false,
                value: None,
            });
        }
        Err(error) => return Err(error),
    };
    let limit = crate::TURN_CAPTURE_BOUND - 128;
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(crate::refused());
    }
    Ok(Loaded {
        present: true,
        value: Some(serde_json::from_slice(&bytes)?),
    })
}

pub(crate) fn save(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut nonce = [0; 16];
    getrandom::getrandom(&mut nonce).map_err(|_| crate::refused())?;
    let name = NativeOperationId::from_random_bytes(nonce);
    let temporary = parent.join(format!(".hands-state-{}.tmp", name.as_str()));
    let directory = File::open(parent)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = publish(path, &temporary, &directory, &mut file, bytes);
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn publish(
    path: &Path,
    temporary: &Path,
    directory: &File,
    file: &mut File,
    bytes: &[u8],
) -> io::Result<()> {
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    directory.sync_all()
}
