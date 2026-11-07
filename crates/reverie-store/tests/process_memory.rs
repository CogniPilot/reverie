//! Actual process contention and killed-writer recovery; synthetic paths only.
use reverie_store::memory::{EpisodeInput, MemoryStore};
#[path = "process_memory/readiness.rs"]
mod readiness;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "memory-process-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().unwrap().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
fn child(root: &Path, mode: &str, index: usize) -> OwnedChild {
    OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "memory_process_child",
                "--nocapture",
            ])
            .env("REVERIE_TEST_MEMORY_ROOT", root)
            .env("REVERIE_TEST_MEMORY_MODE", mode)
            .env("REVERIE_TEST_MEMORY_INDEX", index.to_string())
            .current_dir(root)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    )
}
fn wait_ready(root: &Path, index: usize, child: &mut OwnedChild) {
    let start = Instant::now();
    while !root.join(format!("ready-{index}")).exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "fixture exited before readiness"
        );
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "fixture readiness timeout"
        );
        thread::sleep(Duration::from_millis(2));
    }
}
fn wait_success(child: &mut OwnedChild) {
    let start = Instant::now();
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success(), "child failed: {status}");
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "fixture completion timeout"
        );
        thread::sleep(Duration::from_millis(2));
    }
}
#[test]
#[ignore = "helper entered only by owned process qualification tests"]
fn memory_process_child() {
    let root = PathBuf::from(std::env::var_os("REVERIE_TEST_MEMORY_ROOT").unwrap());
    let mode = std::env::var("REVERIE_TEST_MEMORY_MODE").unwrap();
    let index = std::env::var("REVERIE_TEST_MEMORY_INDEX").unwrap();
    if mode == "constructors" {
        constructor_paths();
        return;
    }
    if mode.starts_with("readiness-") {
        readiness::writer(&root, &mode, &index);
        return;
    }
    let store = MemoryStore::open(root.join("memory.sqlite")).unwrap();
    if mode == "claim" {
        fs::write(root.join(format!("ready-{index}")), b"ready").unwrap();
        let start = Instant::now();
        while !root.join("go").exists() {
            assert!(start.elapsed() < Duration::from_secs(10));
            thread::sleep(Duration::from_millis(2));
        }
        let claimed = store.claim_message("synthetic:claim", Some(100.0)).unwrap();
        let memory = store
            .add_external_episode("synthetic:external", "user", "assistant", "private")
            .unwrap();
        fs::write(
            root.join(format!("result-{index}.json")),
            format!("{{\"claimed\":{claimed},\"id\":{}}}", memory.id),
        )
        .unwrap();
        store.close().unwrap();
        return;
    }
    store
        .atomic::<()>(|tx| {
            tx.set_state("prefix", "retained only after explicit commit")?;
            tx.add_episode(EpisodeInput::new("pending user", "pending assistant"))?;
            if mode == "crash-committed" {
                tx.claim_message("synthetic:committed", Some(100.0))?;
            }
            fs::write(root.join(format!("ready-{index}")), b"transaction reached").unwrap();
            loop {
                thread::park_timeout(Duration::from_secs(60));
            }
        })
        .unwrap();
}
fn constructor_paths() {
    assert!(MemoryStore::open("").is_err());
    for name in [":memory:", "./:memory:", ":memory:/"] {
        let store = MemoryStore::open(name).unwrap();
        assert_eq!(store.path(), Path::new(":memory:"));
        store.set_state("ephemeral", "yes").unwrap();
        store.close().unwrap();
        assert_eq!(fs::read_dir(".").unwrap().count(), 0);
    }
    let name = "file:synthetic?mode=memory";
    let store = MemoryStore::open(name).unwrap();
    store.set_state("literal", "retained").unwrap();
    store.backup_to("file:snapshot?mode=memory").unwrap();
    assert!(Path::new(name).is_file());
    assert!(Path::new("file:snapshot?mode=memory").is_file());
    store.close().unwrap();
    let store = MemoryStore::open(name).unwrap();
    assert_eq!(
        store.get_state("literal", None).unwrap().as_deref(),
        Some("retained")
    );
    store.set_state("literal", "changed").unwrap();
    store.restore_from("file:snapshot?mode=memory").unwrap();
    assert_eq!(
        store.get_state("literal", None).unwrap().as_deref(),
        Some("retained")
    );
    store.close().unwrap();
}
#[test]
fn actual_legacy_constructor_paths_and_literal_uri_filenames_match_in_owned_cwd() {
    let tree = Tree::new();
    let mut process = child(&tree.0, "constructors", 0);
    wait_success(&mut process);
}
#[test]
fn two_actual_processes_claim_once_and_publish_one_external_memory() {
    let tree = Tree::new();
    MemoryStore::open(tree.0.join("memory.sqlite"))
        .unwrap()
        .close()
        .unwrap();
    let mut first = child(&tree.0, "claim", 0);
    let mut second = child(&tree.0, "claim", 1);
    wait_ready(&tree.0, 0, &mut first);
    wait_ready(&tree.0, 1, &mut second);
    fs::write(tree.0.join("go"), b"go").unwrap();
    wait_success(&mut first);
    wait_success(&mut second);
    let first: serde_json::Value =
        serde_json::from_slice(&fs::read(tree.0.join("result-0.json")).unwrap()).unwrap();
    let second: serde_json::Value =
        serde_json::from_slice(&fs::read(tree.0.join("result-1.json")).unwrap()).unwrap();
    assert_ne!(first["claimed"], second["claimed"]);
    assert_eq!(first["id"], second["id"]);
    let store = MemoryStore::open(tree.0.join("memory.sqlite")).unwrap();
    assert_eq!(store.count(None).unwrap(), 1);
    assert!(store.answered("synthetic:claim").unwrap());
    store.close().unwrap();
}
#[cfg(unix)]
#[test]
fn sigkill_recovers_uncommitted_atomic_and_retains_explicit_commit_prefix() {
    use std::os::unix::process::ExitStatusExt;
    for (mode, committed) in [("crash-pending", false), ("crash-committed", true)] {
        let tree = Tree::new();
        let store = MemoryStore::open(tree.0.join("memory.sqlite")).unwrap();
        store.set_state("unrelated", "preserved").unwrap();
        store.close().unwrap();
        let mut writer = child(&tree.0, mode, 0);
        wait_ready(&tree.0, 0, &mut writer);
        writer.0.kill().unwrap();
        assert_eq!(writer.0.wait().unwrap().signal(), Some(9));
        let store = MemoryStore::open(tree.0.join("memory.sqlite")).unwrap();
        assert_eq!(
            store.get_state("unrelated", None).unwrap().as_deref(),
            Some("preserved")
        );
        assert_eq!(
            store.get_state("prefix", None).unwrap().is_some(),
            committed
        );
        assert_eq!(store.count(None).unwrap(), i64::from(committed));
        assert_eq!(store.answered("synthetic:committed").unwrap(), committed);
        store.close().unwrap();
    }
}
