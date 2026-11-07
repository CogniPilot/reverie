use super::*;
use std::{
    cell::{Cell, RefCell},
    os::unix::fs::PermissionsExt,
    sync::{Arc, Barrier},
};
type Hook = Box<dyn FnOnce(&Path)>;
thread_local! {static HOOK:RefCell<Option<Hook>>=RefCell::new(None);}
thread_local! {static FAIL_PUBLISHED_CLOSE:Cell<bool>=const{Cell::new(false)};}
pub(super) fn after_publish() {
    FAIL_PUBLISHED_CLOSE.with(|flag| {
        if flag.replace(false) {
            native::test_faults::set(None, true);
        }
    });
}
pub(super) fn after_prepare(path: &Path) {
    HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook(path);
        }
    });
}
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "memory-profile-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn fresh_profile_is_durable_and_existing_owner_profile_is_preserved_without_encoding() {
    let tree = Tree::new();
    let target = tree.0.join("profile.md");
    let file = ProfileFile(target.clone());
    assert_eq!(
        file.ensure(&PythonText::from_scalar_text("derived K\n"))
            .unwrap(),
        ProfileOutcome::Installed
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "derived K\n");
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        file.ensure(&PythonText::try_new(vec![0xd800]).unwrap())
            .unwrap(),
        ProfileOutcome::Existing
    );
    assert_eq!(fs::read_dir(&tree.0).unwrap().count(), 1);
    assert_eq!(fs::read_to_string(&target).unwrap(), "derived K\n");
}
#[test]
fn concurrent_startups_never_overwrite_an_already_published_profile() {
    let tree = Tree::new();
    let target = tree.0.join("profile.md");
    let barrier = Arc::new(Barrier::new(2));
    let workers = ["one", "two"].map(|value| {
        let target = target.clone();
        let barrier = Arc::clone(&barrier);
        std::thread::spawn(move || {
            barrier.wait();
            ProfileFile(target)
                .ensure(&PythonText::from_scalar_text(value))
                .unwrap()
        })
    });
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|&&result| result == ProfileOutcome::Installed)
            .count(),
        1
    );
    assert!(matches!(
        fs::read_to_string(target).unwrap().as_str(),
        "one" | "two"
    ));
    assert_eq!(fs::read_dir(&tree.0).unwrap().count(), 1);
}
#[test]
fn prepared_swap_edit_link_and_mode_drift_preserve_foreign_data_and_refuse_publication() {
    for mode in 0..4 {
        let tree = Tree::new();
        let target = tree.0.join("profile.md");
        let other = tree.0.join("other");
        HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |path| match mode {
                0 => {
                    fs::remove_file(path).unwrap();
                    fs::write(path, b"foreign").unwrap();
                }
                1 => fs::write(path, b"edited").unwrap(),
                2 => fs::hard_link(path, other).unwrap(),
                _ => fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap(),
            }))
        });
        assert!(
            ProfileFile(target.clone())
                .ensure(&PythonText::from_scalar_text("derived"))
                .is_err()
        );
        assert!(!target.exists());
        let temporary = fs::read_dir(&tree.0)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .as_encoded_bytes()
                    .starts_with(b".profile-")
            })
            .unwrap();
        if mode == 0 {
            assert_eq!(fs::read(temporary).unwrap(), b"foreign");
        }
    }
}
#[test]
fn publication_close_uncertainty_keeps_installed_data_and_never_rolls_back() {
    let tree = Tree::new();
    let target = tree.0.join("profile.md");
    FAIL_PUBLISHED_CLOSE.with(|flag| flag.set(true));
    let error = ProfileFile(target.clone())
        .ensure(&PythonText::from_scalar_text("retained"))
        .unwrap_err();
    assert!(matches!(error, ProfileError::Uncertain(_)));
    assert_eq!(fs::read(target).unwrap(), b"retained");
    assert_eq!(fs::read_dir(&tree.0).unwrap().count(), 1);
    native::test_faults::set(None, false);
}
#[test]
fn parent_rebinding_never_creates_or_removes_a_replacement_directorys_foreign_leaf() {
    let tree = Tree::new();
    let moved = tree.0.with_extension("moved");
    let parent = File::open(&tree.0).unwrap();
    fs::rename(&tree.0, &moved).unwrap();
    fs::create_dir(&tree.0).unwrap();
    let leaf = std::ffi::OsStr::new(".profile-owned.tmp");
    let foreign = tree.0.join(leaf);
    fs::write(&foreign, b"foreign").unwrap();
    let mut file = native::create_memory_profile(&parent, leaf).unwrap();
    file.write_all(b"owned original directory").unwrap();
    file.sync_all().unwrap();
    assert_eq!(fs::read(&foreign).unwrap(), b"foreign");
    assert_eq!(
        fs::read(moved.join(leaf)).unwrap(),
        b"owned original directory"
    );
    native::remove_memory_profile(&parent, leaf).unwrap();
    assert_eq!(fs::read(&foreign).unwrap(), b"foreign");
    native::close(file).unwrap();
    native::close(parent).unwrap();
    fs::remove_dir_all(moved).unwrap();
}
