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

/// Executable build root, distinct from a same-architecture object/library.
/// Maintained readelf still validates its program headers during assembly.
pub fn executable_machine(path: &Path) -> Result<u16> {
    let architecture = machine(path)?.ok_or_else(|| refused("executable ELF required"))?;
    let mut header = [0; 32];
    fs::File::open(path)?.read_exact(&mut header)?;
    if fs::metadata(path)?.mode() & 0o111 == 0 || !executable_header(&header) {
        return Err(refused("executable ELF type, entry and file mode required"));
    }
    Ok(architecture)
}

fn executable_header(header: &[u8; 32]) -> bool {
    let kind = u16::from_le_bytes([header[16], header[17]]);
    let entry = match header[4] {
        1 => u64::from(u32::from_le_bytes(
            header[24..28].try_into().expect("fixed header"),
        )),
        2 => u64::from_le_bytes(header[24..32].try_into().expect("fixed header")),
        _ => return false,
    };
    matches!(kind, 2 | 3) && entry != 0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn executable_root_refuses_relocatable_objects_zero_entries_and_unknown_classes() {
        // DATA only, never executed or represented as a complete ELF.
        let mut header = [0; 32];
        header[4] = 2;
        header[16] = 2;
        header[24] = 1;
        assert!(executable_header(&header));
        header[16] = 3;
        assert!(executable_header(&header));
        header[16] = 1; // ET_REL can otherwise have no interpreter/DT_NEEDED.
        assert!(!executable_header(&header));
        header[16] = 2;
        header[24] = 0;
        assert!(!executable_header(&header));
        header[24] = 1;
        header[4] = 0;
        assert!(!executable_header(&header));
        header[4] = 1;
        assert!(executable_header(&header));
    }
}
