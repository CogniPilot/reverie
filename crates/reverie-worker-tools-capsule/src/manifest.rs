use crate::{Result, capsule::PREFIX, refused};
use reverie_elf_bundle::digest;
use serde::Serialize;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
struct Entry {
    path: String,
    sha256: String,
    bytes: u64,
    mode: u32,
}
#[derive(Serialize)]
struct Manifest {
    version: u8,
    purpose: &'static str,
    entry: String,
    terminfo: String,
    files: Vec<Entry>,
}
fn inventory(root: &Path) -> Result<Vec<Entry>> {
    let mut pending = vec![PathBuf::new()];
    let mut files = Vec::new();
    let mut total = 0_u64;
    while let Some(relative) = pending.pop() {
        for item in fs::read_dir(root.join(relative))? {
            let path = item?.path();
            let info = fs::symlink_metadata(&path)?;
            if info.is_dir() {
                pending.push(path.strip_prefix(root)?.to_owned());
                continue;
            }
            if !info.is_file() || files.len() >= 8192 || info.len() > 128 * 1024 * 1024 {
                return Err(refused("bounded regular worker tool files required"));
            }
            total = total
                .checked_add(info.len())
                .filter(|v| *v <= 256 * 1024 * 1024)
                .ok_or_else(|| refused("bounded worker tools total required"))?;
            files.push(Entry {
                path: path
                    .strip_prefix(root)?
                    .to_str()
                    .ok_or_else(|| refused("UTF8 artifact path required"))?
                    .to_owned(),
                sha256: digest(&path)?,
                bytes: info.len(),
                mode: if info.permissions().mode() & 0o111 != 0 {
                    0o555
                } else {
                    0o444
                },
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}
pub(crate) fn write(root: &Path) -> Result<()> {
    let files = inventory(root)?;
    if !files
        .iter()
        .any(|f| f.path == "bin/tmux" && f.mode == 0o555)
        || !files.iter().any(|f| f.path.starts_with("share/terminfo/"))
    {
        return Err(refused("fixed executable tmux and terminal data required"));
    }
    let manifest = Manifest {
        version: 1,
        purpose: "reverie-worker-tools-v1",
        entry: format!("{PREFIX}/bin/tmux"),
        terminfo: format!("{PREFIX}/share/terminfo"),
        files,
    };
    let raw = serde_json::to_vec(&manifest)?;
    if raw.len() > 2 * 1024 * 1024 {
        return Err(refused("bounded worker tools manifest required"));
    }
    fs::write(root.join("manifest.json"), raw)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "worker-tool-manifest-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn manifest_is_sorted_and_contains_closed_fixed_roles() {
        let root = Scratch::new();
        fs::create_dir_all(root.0.join("share/terminfo/x")).unwrap();
        fs::create_dir(root.0.join("bin")).unwrap();
        fs::write(root.0.join("bin/tmux"), b"ELF data only, not executed").unwrap();
        fs::set_permissions(root.0.join("bin/tmux"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(root.0.join("share/terminfo/x/xterm"), b"terminal data").unwrap();
        write(&root.0).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(root.0.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(value["entry"], "/opt/reverie-worker-tools/bin/tmux");
        assert_eq!(
            value["terminfo"],
            "/opt/reverie-worker-tools/share/terminfo"
        );
        assert_eq!(value["files"][0]["path"], "bin/tmux");
        assert_eq!(value["files"][0]["mode"], 0o555);
        assert_eq!(value["files"][1]["mode"], 0o444);
    }
    #[test]
    fn symlink_artifact_cannot_enter_the_manifest() {
        let root = Scratch::new();
        fs::write(root.0.join("regular"), b"data").unwrap();
        symlink("regular", root.0.join("alias")).unwrap();
        assert!(inventory(&root.0).is_err());
    }
}
