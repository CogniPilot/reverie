use crate::{Result, copy, refused};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
};

/// Preserve the complete module tree, including foreign-platform inert assets.
/// Symlinks must resolve within the supplied immutable package root.
pub fn tree(source: &Path, target: &Path) -> Result<Vec<PathBuf>> {
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

pub fn readonly(root: &Path) -> Result<()> {
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
