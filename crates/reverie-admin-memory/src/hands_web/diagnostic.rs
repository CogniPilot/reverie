use nix::{
    fcntl::{OFlag, open},
    sys::stat::Mode,
};
use serde_json::Value;
use std::{
    fs::{File, Permissions},
    io::{self, Write},
    os::unix::fs::PermissionsExt,
    path::Path,
};

pub(super) fn append(path: &Path, mut line: String) -> io::Result<()> {
    if line.contains(['\r', '\n']) || !serde_json::from_str::<Value>(&line)?.is_object() {
        return Err(crate::refused());
    }
    line.push('\n');
    let flags = OFlag::O_WRONLY
        | OFlag::O_APPEND
        | OFlag::O_CREAT
        | OFlag::O_NOFOLLOW
        | OFlag::O_NONBLOCK
        | OFlag::O_CLOEXEC;
    let mut file = File::from(open(path, flags, Mode::S_IRUSR | Mode::S_IWUSR)?);
    let info = file.metadata()?;
    if !info.is_file() {
        return Err(crate::refused());
    }
    if info.permissions().mode() & 0o077 != 0 {
        file.set_permissions(Permissions::from_mode(0o600))?;
    }
    file.write_all(line.as_bytes())
}

#[cfg(test)]
mod tests;
