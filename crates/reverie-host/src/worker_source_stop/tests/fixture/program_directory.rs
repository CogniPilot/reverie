//! Only the cached fixture program's build directory, never worker storage.
use std::{
    fs, io,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};

pub(super) fn allocate(parent: &Path) -> io::Result<PathBuf> {
    let nonce =
        reverie_store::worker_storage::instruction_temporary_name().map_err(io::Error::other)?;
    let path = parent.join(format!("source-stop-build-{}-{nonce}", std::process::id()));
    fs::DirBuilder::new().mode(0o700).create(&path)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    #[test]
    fn same_pid_build_allocations_preserve_the_existing_legacy_directory() {
        let nonce = reverie_store::worker_storage::instruction_temporary_name().unwrap();
        let parent = std::env::temp_dir().join(format!("source-stop-allocator-{nonce}"));
        fs::DirBuilder::new().mode(0o700).create(&parent).unwrap();
        let legacy = parent.join(format!("source-stop-build-{}", std::process::id()));
        fs::DirBuilder::new().mode(0o700).create(&legacy).unwrap();
        let marker = legacy.join("original-marker");
        fs::write(&marker, b"preexisting owned fixture marker").unwrap();
        let original = fs::symlink_metadata(&legacy).unwrap();
        let original_marker = fs::symlink_metadata(&marker).unwrap();
        let first = allocate(&parent);
        let second = allocate(&parent);
        let current = fs::symlink_metadata(&legacy).unwrap();
        let current_marker = fs::symlink_metadata(&marker).unwrap();
        let preserved = (original.dev(), original.ino()) == (current.dev(), current.ino())
            && (original_marker.dev(), original_marker.ino())
                == (current_marker.dev(), current_marker.ino())
            && fs::read(&marker).unwrap() == b"preexisting owned fixture marker";
        let distinct_private = match (&first, &second) {
            (Ok(first), Ok(second)) => {
                first != second
                    && first != &legacy
                    && second != &legacy
                    && [first, second].iter().all(|path| {
                        let metadata = fs::symlink_metadata(path).unwrap();
                        metadata.is_dir()
                            && metadata.permissions().mode() & 0o777 == 0o700
                            && path.parent() == Some(parent.as_path())
                    })
            }
            _ => false,
        };
        let mut created = [&first, &second]
            .into_iter()
            .filter_map(|value| value.as_ref().ok())
            .filter(|path| **path != legacy)
            .collect::<Vec<_>>();
        created.sort();
        created.dedup();
        for path in created {
            fs::remove_dir(path).unwrap();
        }
        fs::remove_file(marker).unwrap();
        fs::remove_dir(legacy).unwrap();
        fs::remove_dir(parent).unwrap();
        assert!(
            preserved,
            "original directory and marker must remain untouched"
        );
        assert!(
            distinct_private,
            "fresh private allocations required: first={first:?}, second={second:?}"
        );
    }
}
