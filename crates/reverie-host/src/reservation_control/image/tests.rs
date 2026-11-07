use super::*;
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-image-binding-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let tree = Self(root);
        tree.write(b"{\"image\":\"old\"}");
        tree
    }
    fn path(&self) -> PathBuf {
        self.0.join("config.json")
    }
    fn write(&self, bytes: &[u8]) {
        fs::write(self.path(), bytes).unwrap();
        fs::set_permissions(self.path(), fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn config(&self) -> EffectiveWorkerConfig {
        reverie_contracts::worker_config::decode(b"{\"image\":\"old\"}").unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        native::test_faults::set(None, false);
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn image_binding_is_closed_and_refuses_same_image_replacement_or_edit() {
    let tree = Tree::new();
    let bound = capture_current_image(&tree.path(), &tree.config()).unwrap();
    bound.assert_current().unwrap();
    fs::rename(tree.path(), tree.0.join("old.json")).unwrap();
    tree.write(b"{\"image\":\"old\"}");
    assert!(matches!(
        bound.assert_current(),
        Err(ImageHostError::Changed)
    ));
    let bound = capture_current_image(&tree.path(), &tree.config()).unwrap();
    tree.write(b"{\"image\":\"new\"}");
    assert!(matches!(
        bound.assert_current(),
        Err(ImageHostError::Changed)
    ));
}
#[test]
fn image_leaf_policy_is_distinct_from_ancestor_and_loader_policy() {
    let tree = Tree::new();
    symlink(&tree.0, tree.0.join("ancestor")).unwrap();
    capture_current_image(&tree.0.join("ancestor/config.json"), &tree.config()).unwrap();
    fs::set_permissions(tree.path(), fs::Permissions::from_mode(0o400)).unwrap();
    capture_current_image(&tree.path(), &tree.config()).unwrap();
    fs::set_permissions(tree.path(), fs::Permissions::from_mode(0o640)).unwrap();
    assert!(matches!(
        capture_current_image(&tree.path(), &tree.config()),
        Err(ImageHostError::Custody)
    ));
    fs::set_permissions(tree.path(), fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(tree.path(), tree.0.join("hard.json")).unwrap();
    assert!(matches!(
        capture_current_image(&tree.path(), &tree.config()),
        Err(ImageHostError::Custody)
    ));
    fs::remove_file(tree.0.join("hard.json")).unwrap();
    symlink("config.json", tree.0.join("leaf.json")).unwrap();
    assert!(matches!(
        capture_current_image(&tree.0.join("leaf.json"), &tree.config()),
        Err(ImageHostError::Native(_))
    ));
}
#[test]
fn image_bound_refusal_precedes_parsing_and_stale_image_follows_close() {
    let tree = Tree::new();
    tree.write(&vec![b' '; MAX + 1]);
    assert!(matches!(
        capture_current_image(&tree.path(), &tree.config()),
        Err(ImageHostError::Custody)
    ));
    tree.write(b"{\"image\":\"foreign\"}");
    native::test_faults::set(None, true);
    assert!(matches!(
        capture_current_image(&tree.path(), &tree.config()),
        Err(ImageHostError::Native(_))
    ));
    assert!(matches!(
        capture_current_image(&tree.path(), &tree.config()),
        Err(ImageHostError::Data(CurrentImageDataError::Stale))
    ));
    tree.write(b"{");
    native::test_faults::set(None, true);
    assert!(
        matches!(capture_current_image(&tree.path(),&tree.config()),Err(ImageHostError::Finalization{primary,secondary}) if matches!(*primary,ImageHostError::Data(CurrentImageDataError::Json))&&matches!(*secondary,ImageHostError::Native(_)))
    );
}
#[test]
fn image_changes_while_reading_refuse_before_json() {
    let tree = Tree::new();
    tree.write(b"{");
    native::test_faults::set(
        Some(Box::new(|path| {
            fs::write(path, b"new")?;
            Ok(())
        })),
        false,
    );
    assert!(matches!(
        capture_current_image(&tree.path(), &tree.config()),
        Err(ImageHostError::Changed)
    ));
}
#[test]
fn image_strict_bytes_and_python_equality_are_preserved() {
    let tree = Tree::new();
    let config = reverie_contracts::worker_config::decode(b"{\"image\":1}").unwrap();
    for raw in [
        b"{\"image\":true}".as_slice(),
        b"{\"image\":1.0,\"extra\":1e999}",
    ] {
        tree.write(raw);
        capture_current_image(&tree.path(), &config).unwrap();
    }
    tree.write(b"{\"image\":1,\"extra\":NaN}");
    assert!(matches!(
        capture_current_image(&tree.path(), &config),
        Err(ImageHostError::Data(CurrentImageDataError::Json))
    ));
    tree.write(b"{\"image\":1,\"image\":1}");
    assert!(matches!(
        capture_current_image(&tree.path(), &config),
        Err(ImageHostError::Data(CurrentImageDataError::DuplicateKey))
    ));
    let raw = "{\"image\":1}"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    tree.write(&raw);
    capture_current_image(&tree.path(), &config).unwrap();
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Oracle {
    name: String,
    raw_hex: String,
    config: String,
    accepted: bool,
    error: Option<String>,
}
#[test]
fn actual_legacy_current_image_read_acceptance_and_error_hooks() {
    let cases: Vec<Oracle> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/reservation-current-image-python.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 15);
    let tree = Tree::new();
    for case in cases {
        let raw = case
            .raw_hex
            .as_bytes()
            .chunks_exact(2)
            .map(|part| u8::from_str_radix(std::str::from_utf8(part).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        tree.write(&raw);
        let config = reverie_contracts::worker_config::decode(case.config.as_bytes()).unwrap();
        let result = capture_current_image(&tree.path(), &config);
        assert_eq!(result.is_ok(), case.accepted, "{}: {result:?}", case.name);
        if let Some(code) = case
            .error
            .filter(|value| !value.starts_with("Exceeds the limit"))
        {
            assert_eq!(result.unwrap_err().code(), code, "{}", case.name);
        }
    }
}
