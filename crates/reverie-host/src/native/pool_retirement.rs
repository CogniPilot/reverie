//! Fixed no-replace archival names selected only by the failed-installation
//! owner while its original stopped IMAGE and maintenance owners remain held.
use std::{fs::File, io};
pub(crate) fn archive_failed_pool_policies(source: &File, history: &File) -> io::Result<()> {
    super::rename::noreplace(source, c"policies", history, c"policies-before")
}
pub(crate) fn archive_failed_pool_control(source: &File, history: &File) -> io::Result<()> {
    super::rename::noreplace(source, c"control", history, c"control-before")
}
pub(crate) fn archive_uninstalled_pool_pending(source: &File, history: &File) -> io::Result<()> {
    super::rename::noreplace(
        source,
        c"resource-reservation-control.pending",
        history,
        c"pending-before.json",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{DirBuilderExt, MetadataExt},
        path::PathBuf,
    };
    struct Tree(PathBuf);
    impl Tree {
        fn new() -> Self {
            let nonce = crate::resource_facts::fresh_owner_nonce().unwrap();
            let path =
                std::env::temp_dir().join(format!("reverie-pending-archive-{}", nonce.as_str()));
            fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
            fs::create_dir(path.join("source")).unwrap();
            fs::create_dir(path.join("history")).unwrap();
            Self(path)
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn pending_archival_preserves_the_same_inode_and_original_bytes() {
        let tree = Tree::new();
        let original = tree.0.join("source/resource-reservation-control.pending");
        fs::write(&original, b"original UNKNOWN bytes").unwrap();
        let held = File::open(&original).unwrap();
        let before = held.metadata().unwrap();
        archive_uninstalled_pool_pending(
            &File::open(tree.0.join("source")).unwrap(),
            &File::open(tree.0.join("history")).unwrap(),
        )
        .unwrap();
        let archived = tree.0.join("history/pending-before.json");
        let after = fs::metadata(&archived).unwrap();
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        assert_eq!(fs::read(archived).unwrap(), b"original UNKNOWN bytes");
        assert!(!original.exists());
        assert_eq!(held.metadata().unwrap().nlink(), 1);
    }
    #[test]
    fn archive_collision_preserves_both_original_records() {
        let tree = Tree::new();
        let original = tree.0.join("source/resource-reservation-control.pending");
        let archived = tree.0.join("history/pending-before.json");
        fs::write(&original, b"original").unwrap();
        fs::write(&archived, b"existing history").unwrap();
        let error = archive_uninstalled_pool_pending(
            &File::open(tree.0.join("source")).unwrap(),
            &File::open(tree.0.join("history")).unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(original).unwrap(), b"original");
        assert_eq!(fs::read(archived).unwrap(), b"existing history");
    }
}
