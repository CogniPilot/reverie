//! Private API key and Unix socket handling.
use reverie_local_model::{prepare_socket, private_key};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("local-model-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn restart_removes_only_an_abandoned_private_socket() {
    let scratch = Scratch::new("socket");
    let path = scratch.0.join("model.sock");
    prepare_socket(&path).unwrap();
    {
        let _listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            prepare_socket(&path)
                .unwrap_err()
                .0
                .contains("already has a listener")
        );
        assert!(path.exists());
    }
    prepare_socket(&path).unwrap();
    assert!(!path.exists());
    fs::write(&path, "preserve me").unwrap();
    assert!(prepare_socket(&path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "preserve me");
}

#[test]
fn reuses_private_key_and_refuses_symlink_or_public_permissions() {
    let scratch = Scratch::new("key");
    let path = scratch.0.join("models/key");
    private_key(&path).unwrap();
    let value = fs::read(&path).unwrap();
    assert_eq!(value.len(), 65);
    private_key(&path).unwrap();
    assert_eq!(fs::read(&path).unwrap(), value);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(private_key(&path).is_err());
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(scratch.0.join("target"), &path).unwrap();
    assert!(private_key(&path).is_err());
    assert!(!scratch.0.join("target").exists());
}
