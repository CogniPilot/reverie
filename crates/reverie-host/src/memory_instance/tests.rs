use super::*;
use std::{
    os::unix::ffi::OsStringExt,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "memory-instance-{}-{}",
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
fn config(data: &str, extra: &str) -> String {
    format!(
        r#"{{"id":"alpha","agent_name":"Agent","owner_name":"Owner","data_dir":{data},"persona":"Selected"{extra}}}"#
    )
}
#[test]
fn actual_config_symlinks_relative_state_and_no_bootstrap_side_effects() {
    let tree = Tree::new();
    let configs = tree.0.join("configs");
    fs::create_dir(&configs).unwrap();
    let path = configs.join("instance.json");
    fs::write(&path, config(r#""../state""#, "")).unwrap();
    let alias = tree.0.join("alias.json");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    let loaded = LoadedMemoryInstance::load(&alias).unwrap();
    assert_eq!(loaded.configuration().id().as_str(), "alpha");
    assert_eq!(
        loaded.native_data_directory().unwrap(),
        tree.0.join("state")
    );
    assert_eq!(
        native::python_path(&loaded.configuration_path().codepoints()).unwrap(),
        path
    );
    assert!(!tree.0.join("state").exists());
    assert_eq!(fs::read_dir(&configs).unwrap().count(), 1);
}
#[test]
fn state_refusal_precedes_later_schema_checks_and_preserves_raw_path_codepoints() {
    let tree = Tree::new();
    let path = tree.0.join("instance.json");
    for state in [r#"".""#, r#""..""#, r#""/""#] {
        fs::write(&path, config(state, r#", "kind":"invalid""#)).unwrap();
        assert!(matches!(
            LoadedMemoryInstance::load(&path),
            Err(InstanceLoadError::SeparateStateRequired)
        ));
    }
    fs::write(&path, config(r#""state\udcff""#, "")).unwrap();
    let loaded = LoadedMemoryInstance::load(&path).unwrap();
    assert_eq!(
        loaded.native_data_directory().unwrap(),
        tree.0
            .join(std::ffi::OsString::from_vec(b"state\xff".to_vec()))
    );
    assert_eq!(loaded.data_directory().codepoints().last(), Some(&0xdcff));
    fs::write(&path, config(r#""state\ud800""#, r#", "kind":"invalid""#)).unwrap();
    assert!(matches!(
        LoadedMemoryInstance::load(&path),
        Err(InstanceLoadError::Io(_))
    ));
    assert!(!tree.0.join("state").exists());
}
#[test]
fn fixed_passwd_owner_supports_current_named_home_and_unknown_account_refusal() {
    let username = native::username(native::uid()).unwrap();
    let named = native::home_directory(Some(&username)).unwrap();
    assert_eq!(named, native::home_directory(None).unwrap());
    let mut tilde = vec![126];
    tilde.extend_from_slice(&username);
    tilde.extend([47, 97]);
    assert_eq!(
        expanded(&tilde).unwrap(),
        PosixPath::try_new(&named)
            .unwrap()
            .join(&PosixPath::from_scalar_text("a"))
    );
    assert!(native::home_directory(Some(&[0])).is_err());
    assert!(native::home_directory(Some(&[0xd800])).is_err());
    assert!(
        matches!(native::home_directory(Some(&"reverie-owned-missing-account-9384".chars().map(u32::from).collect::<Vec<_>>())),Err(error) if error.kind()==io::ErrorKind::NotFound)
    );
}
