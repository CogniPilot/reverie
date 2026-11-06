use super::*;
use reverie_core::{
    PythonText,
    memory::MemoryScope,
    memory_context::{EmployeeContext, ScopeReference, ScopeResource},
    memory_instance::InstanceId,
};
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "memory-context-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let tree = Self(path.canonicalize().unwrap());
        let context = InstalledMemoryContext::try_new(
            ScopeReference::parse("configured-existing").unwrap(),
            InstanceId::parse("Existing_Instance").unwrap(),
            EmployeeContext::try_new(
                None,
                ScopeReference::parse("old-employee").unwrap(),
                ScopeReference::parse("ses_old").unwrap(),
                1,
            )
            .unwrap(),
            PythonText::from_scalar_text("/existing/config.json"),
            vec![ScopeResource::new(
                ScopeReference::parse("configured-private").unwrap(),
                MemoryScope::Private,
            )],
        )
        .unwrap();
        fs::write(tree.file(), wire::encode(&context).unwrap()).unwrap();
        fs::set_permissions(tree.file(), fs::Permissions::from_mode(0o444)).unwrap();
        tree
    }
    fn file(&self) -> PathBuf {
        self.0.join("context.json")
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn held_context_is_readonly_and_unrelated_directory_activity_does_not_invalidate_it() {
    let tree = Tree::new();
    let before = fs::read(tree.file()).unwrap();
    let mut context = InstalledContext::capture_at(&tree.file()).unwrap();
    assert_eq!(context.data().instance().as_str(), "Existing_Instance");
    assert_eq!(context.fingerprint(), &wire::fingerprint(&before).unwrap());
    fs::create_dir(tree.0.join("unrelated")).unwrap();
    context.assert_current().unwrap();
    context.close().unwrap();
    context.close().unwrap();
    assert!(matches!(
        context.assert_current(),
        Err(ContextError::Closed)
    ));
    assert_eq!(fs::read(tree.file()).unwrap(), before);
}
#[test]
fn foreign_same_bytes_rebinding_is_negative_and_never_removed() {
    let tree = Tree::new();
    let bytes = fs::read(tree.file()).unwrap();
    let mut context = InstalledContext::capture_at(&tree.file()).unwrap();
    fs::rename(tree.file(), tree.0.join("old")).unwrap();
    fs::write(tree.file(), &bytes).unwrap();
    fs::set_permissions(tree.file(), fs::Permissions::from_mode(0o444)).unwrap();
    assert!(matches!(
        context.assert_current(),
        Err(ContextError::Changed)
    ));
    assert!(context.close().is_err());
    assert!(matches!(
        context.close(),
        Err(ContextError::CloseUnconfirmed)
    ));
    assert_eq!(fs::read(tree.file()).unwrap(), bytes);
}
#[test]
fn writable_linked_or_symbolic_context_cannot_be_selected() {
    let tree = Tree::new();
    fs::set_permissions(tree.file(), fs::Permissions::from_mode(0o644)).unwrap();
    assert!(InstalledContext::capture_at(&tree.file()).is_err());
    fs::set_permissions(tree.file(), fs::Permissions::from_mode(0o444)).unwrap();
    fs::hard_link(tree.file(), tree.0.join("linked")).unwrap();
    assert!(InstalledContext::capture_at(&tree.file()).is_err());
    fs::remove_file(tree.0.join("linked")).unwrap();
    symlink(tree.file(), tree.0.join("symbolic")).unwrap();
    assert!(InstalledContext::capture_at(&tree.0.join("symbolic")).is_err());
    symlink(&tree.0, tree.0.join("dir-alias")).unwrap();
    assert!(InstalledContext::capture_at(&tree.0.join("dir-alias/context.json")).is_err());
}
#[test]
fn fifo_type_refusal_is_nonblocking_before_any_read() {
    const CASE: &str = "memory_context::tests::fifo_type_refusal_is_nonblocking_before_any_read";
    const ROOT: &str = "OWNED_MEMORY_CONTEXT_FIFO";
    if let Some(root) = std::env::var_os(ROOT) {
        return fifo_case(&PathBuf::from(root).join("context.json"));
    }
    let tree = Tree::new();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", CASE, "--nocapture", "--test-threads=1"])
        .env_clear()
        .env(ROOT, &tree.0)
        .env("PATH", std::env::var_os("PATH").unwrap())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let limit = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() && std::time::Instant::now() < limit {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let timed_out = child.try_wait().unwrap().is_none();
    if timed_out {
        child.kill().unwrap();
    }
    let output = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !timed_out
            && output.status.success()
            && stdout.contains("test result: ok. 1 passed; 0 failed;"),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn fifo_case(path: &Path) {
    fs::remove_file(path).unwrap();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(path)
            .status()
            .unwrap()
            .success()
    );
    fs::set_permissions(path, fs::Permissions::from_mode(0o444)).unwrap();
    let started = std::time::Instant::now();
    assert!(InstalledContext::capture_at(path).is_err());
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
}

#[test]
fn actual_consumed_close_failure_stays_negative_after_remaining_finalizers() {
    let tree = Tree::new();
    let mut context = InstalledContext::capture_at(&tree.file()).unwrap();
    native::test_faults::set(None, true);
    assert!(matches!(context.close(), Err(ContextError::Native(_))));
    assert!(context.entries.is_empty());
    assert!(matches!(
        context.close(),
        Err(ContextError::CloseUnconfirmed)
    ));
}

#[test]
fn malformed_context_and_checked_close_failure_both_survive() {
    let tree = Tree::new();
    fs::set_permissions(tree.file(), fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(tree.file(), b"{not-json").unwrap();
    fs::set_permissions(tree.file(), fs::Permissions::from_mode(0o444)).unwrap();
    native::test_faults::set(None, true);
    let error = InstalledContext::capture_at(&tree.file()).err().unwrap();
    assert!(
        matches!(error,ContextError::Finalization{primary,secondary} if matches!(*primary,ContextError::Codec(_)) && matches!(*secondary,ContextError::Native(_)))
    );
}
