use crate::{Result, capsule::PREFIX, refused};
use reverie_elf_bundle::digest;
use serde::Serialize;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 256;
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
#[derive(Serialize)]
struct Manifest {
    version: u8,
    purpose: &'static str,
    entry: String,
    node: String,
    files: Vec<Entry>,
}
#[derive(Serialize)]
struct Entry {
    path: String,
    sha256: String,
    bytes: u64,
    mode: u32,
}

fn inventory(root: &Path) -> Result<Vec<Entry>> {
    let mut pending = vec![PathBuf::new()];
    let mut entries = Vec::new();
    let mut total = 0_u64;
    while let Some(relative) = pending.pop() {
        for item in fs::read_dir(root.join(relative))? {
            let path = item?.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_dir() {
                pending.push(path.strip_prefix(root)?.to_owned());
                continue;
            }
            if !metadata.is_file() {
                return Err(refused("regular client artifact files only"));
            }
            if entries.len() >= MAX_FILES {
                return Err(refused("bounded capsule file count required"));
            }
            total = total
                .checked_add(metadata.len())
                .filter(|value| *value <= MAX_TOTAL_BYTES)
                .ok_or_else(|| refused("bounded capsule total required"))?;
            entries.push(file_entry(root, &path, &metadata)?);
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

fn file_entry(root: &Path, path: &Path, metadata: &fs::Metadata) -> Result<Entry> {
    if metadata.len() > MAX_FILE_BYTES {
        return Err(refused("bounded capsule artifact required"));
    }
    let path_name = path
        .strip_prefix(root)?
        .to_str()
        .ok_or_else(|| refused("UTF8 relative artifact path required"))?
        .to_owned();
    let mode = if metadata.permissions().mode() & 0o111 != 0 {
        0o555
    } else {
        0o444
    };
    Ok(Entry {
        path: path_name,
        sha256: digest(path)?,
        bytes: metadata.len(),
        mode,
    })
}

pub(crate) fn write(root: &Path) -> Result<()> {
    let files = inventory(root)?;
    let roles = [
        ("bin/node", 0o555),
        ("bin/reverie", 0o555),
        ("bin/reverie.mjs", 0o444),
        ("claude-hooks.json", 0o444),
    ];
    if !roles.iter().all(|(path, mode)| {
        files
            .iter()
            .any(|entry| entry.path == *path && entry.mode == *mode)
    }) {
        return Err(refused(
            "complete executable client/runtime and read-only settings required",
        ));
    }
    let manifest = Manifest {
        version: 1,
        purpose: "reverie-worker-client-v1",
        entry: format!("{PREFIX}/bin/reverie"),
        node: format!("{PREFIX}/bin/node"),
        files,
    };
    let bytes = serde_json::to_vec(&manifest)?;
    if bytes.len() > 128 * 1024 {
        return Err(refused("bounded canonical client manifest required"));
    }
    fs::write(root.join("manifest.json"), bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests;
