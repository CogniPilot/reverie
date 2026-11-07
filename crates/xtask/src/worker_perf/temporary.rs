//! Explicit temporary CI image ownership. Never removes containers or prunes
//! images, and never follows an archive link when removing its checked name.
use super::*;
use std::{fs, path::PathBuf};

pub(crate) fn temporary_image(
    root: &Path,
    image: &str,
    manifest: &Path,
    archive_link: &Path,
) -> Result<()> {
    checked_image(image)?;
    let archive = ArchiveLink::capture(archive_link)?;
    let mut failures = Vec::new();
    if let Err(error) = super::image(root, image, manifest) {
        failures.push(error.to_string());
    }
    match Command::new("docker").args(["image", "rm", image]).status() {
        Ok(status) if status.success() => {}
        Ok(status) => failures.push(format!("temporary worker image cleanup failed: {status}")),
        Err(error) => failures.push(format!("temporary worker image cleanup failed: {error}")),
    }
    if let Err(error) = archive.remove() {
        failures.push(format!(
            "temporary worker archive-link cleanup failed: {error}"
        ));
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; ").into())
    }
}

fn checked_image(image: &str) -> Result<()> {
    let Some(digest) = image.strip_prefix("sha256:") else {
        return Err("temporary worker cleanup requires the exact immutable image ID".into());
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("temporary worker cleanup requires the exact immutable image ID".into());
    }
    Ok(())
}

struct ArchiveLink {
    path: PathBuf,
    target: PathBuf,
}
impl ArchiveLink {
    fn capture(path: &Path) -> Result<Self> {
        let target = fs::read_link(path)?;
        if !fs::canonicalize(&target)?.starts_with("/nix/store")
            || !fs::metadata(&target)?.is_file()
        {
            return Err("temporary worker archive link must name a Nix store file".into());
        }
        Ok(Self {
            path: path.to_owned(),
            target,
        })
    }
    fn remove(self) -> Result<()> {
        if fs::read_link(&self.path)? != self.target {
            return Err("temporary worker archive link changed; preserved replacement".into());
        }
        fs::remove_file(self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_accepts_only_complete_immutable_image_ids() {
        checked_image(&format!("sha256:{}", "a".repeat(64))).unwrap();
        for image in ["reverie-worker:latest", "--force", "sha256:abc"] {
            assert!(checked_image(image).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_preserves_a_changed_archive_link_and_regular_files() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "reverie-perf-cleanup-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir(&root).unwrap();
        let link = root.join("archive");
        symlink("/nix/store/original", &link).unwrap();
        let owned = ArchiveLink {
            path: link.clone(),
            target: PathBuf::from("/nix/store/original"),
        };
        fs::remove_file(&link).unwrap();
        symlink("/nix/store/replacement", &link).unwrap();
        assert!(owned.remove().is_err());
        assert_eq!(
            fs::read_link(&link).unwrap(),
            Path::new("/nix/store/replacement")
        );
        fs::remove_file(&link).unwrap();
        fs::write(&link, b"preserved").unwrap();
        assert!(ArchiveLink::capture(&link).is_err());
        assert_eq!(fs::read(&link).unwrap(), b"preserved");
        fs::remove_file(&link).unwrap();
        let payload = root.join("payload");
        fs::write(&payload, b"preserved archive").unwrap();
        symlink(&payload, &link).unwrap();
        ArchiveLink {
            path: link.clone(),
            target: payload.clone(),
        }
        .remove()
        .unwrap();
        assert!(!link.exists());
        assert_eq!(fs::read(&payload).unwrap(), b"preserved archive");
        fs::remove_file(payload).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
