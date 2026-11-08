use crate::{Result, refused};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
};

pub fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}

pub fn machine(path: &Path) -> Result<Option<u16>> {
    let mut bytes = [0; 20];
    let mut file = fs::File::open(path)?;
    let count = file.read(&mut bytes)?;
    if count < 4 || bytes[..4] != *b"\x7fELF" {
        return Ok(None);
    }
    if count < bytes.len() || bytes[5] != 1 {
        return Err(refused("little-endian ELF header required"));
    }
    Ok(Some(u16::from_le_bytes([bytes[18], bytes[19]])))
}

pub fn copy(source: &Path, target: &Path) -> Result<()> {
    fs::copy(source, target)?;
    let executable = fs::metadata(source)?.mode() & 0o111 != 0;
    fs::set_permissions(
        target,
        fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }),
    )?;
    Ok(())
}
