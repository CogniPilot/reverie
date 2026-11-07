use crate::{Result, refused};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
};

#[derive(serde::Serialize)]
pub(crate) struct Entry {
    pub(crate) path: String,
    pub(crate) input_sha256: Option<String>,
    pub(crate) sha256: String,
    pub(crate) machine: Option<u16>,
    pub(crate) treatment: String,
}

pub(crate) fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn machine(path: &Path) -> Result<Option<u16>> {
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

pub(crate) fn copy(source: &Path, target: &Path) -> Result<()> {
    fs::copy(source, target)?;
    let executable = fs::metadata(source)?.mode() & 0o111 != 0;
    fs::set_permissions(
        target,
        fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }),
    )?;
    Ok(())
}

/// Preserve the complete module tree, including foreign-platform inert assets.
/// Symlinks must resolve within the supplied immutable package root.
pub(crate) fn tree(source: &Path, target: &Path) -> Result<Vec<PathBuf>> {
    fs::create_dir(target)?;
    let mut pending = vec![PathBuf::new()];
    let mut files = Vec::new();
    while let Some(relative) = pending.pop() {
        for item in fs::read_dir(source.join(&relative))? {
            let item = item?;
            let name = relative.join(item.file_name());
            let metadata = fs::symlink_metadata(item.path())?;
            let destination = target.join(&name);
            if metadata.is_symlink() {
                copy_link(&item.path(), &destination, source)?;
            } else if metadata.is_dir() {
                fs::create_dir(destination)?;
                pending.push(name);
            } else if metadata.is_file() {
                copy(&item.path(), &destination)?;
                files.push(name);
            } else {
                return Err(refused("unsupported module filesystem object"));
            }
        }
    }
    files.sort();
    Ok(files)
}

fn copy_link(source: &Path, target: &Path, root: &Path) -> Result<()> {
    let link = fs::read_link(source)?;
    if link.is_absolute() || !source.canonicalize()?.starts_with(root) {
        return Err(refused("module symlink escapes its immutable input"));
    }
    symlink(link, target)?;
    Ok(())
}

pub(crate) fn readonly(root: &Path) -> Result<()> {
    let mut pending = vec![root.to_owned()];
    let mut directories = Vec::new();
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            directories.push(path.clone());
            for entry in fs::read_dir(path)? {
                pending.push(entry?.path());
            }
        } else {
            let mode = if metadata.mode() & 0o111 != 0 {
                0o555
            } else {
                0o444
            };
            fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
        }
    }
    for directory in directories.into_iter().rev() {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o555))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Tree(PathBuf);
    impl Tree {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "memory-capsule-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn complete_tree_keeps_binary_bytes_and_internal_self_reference() {
        let tree_root = Tree::new();
        let source = tree_root.0.join("source");
        let target = tree_root.0.join("target");
        fs::create_dir(&source).unwrap();
        let bytes = b"\x7fELF\0foreign-asset\xff";
        fs::write(source.join("raw"), bytes).unwrap();
        symlink(".", source.join("self")).unwrap();
        assert_eq!(tree(&source, &target).unwrap(), [PathBuf::from("raw")]);
        assert_eq!(fs::read(target.join("self/raw")).unwrap(), bytes);
        assert_eq!(fs::read_link(target.join("self")).unwrap(), Path::new("."));
        assert!(
            tree(&source, &target).is_err(),
            "existing output is never overwritten"
        );
    }
    #[test]
    fn external_and_absolute_module_links_refuse_without_modifying_the_input() {
        let tree_root = Tree::new();
        let source = tree_root.0.join("source");
        fs::create_dir(&source).unwrap();
        fs::write(tree_root.0.join("outside"), b"unchanged").unwrap();
        symlink("../outside", source.join("bad")).unwrap();
        assert!(tree(&source, &tree_root.0.join("target")).is_err());
        assert_eq!(fs::read(tree_root.0.join("outside")).unwrap(), b"unchanged");
        fs::remove_file(source.join("bad")).unwrap();
        fs::write(source.join("inside"), b"unchanged").unwrap();
        symlink(source.join("inside"), source.join("bad")).unwrap();
        assert!(tree(&source, &tree_root.0.join("second")).is_err());
    }
}
