use reverie_application::{
    memory_import::{migrate_history, migrate_history_atomic},
    project_memory::{ProjectMemory, ProjectMemoryError},
};
use reverie_store::memory::MemoryStore;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, UNIX_EPOCH},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "memory-app-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
#[test]
fn explicit_atomic_history_import_rolls_back_a_failed_batch_and_refuses_ambiguous_legacy_rows() {
    let tree = Tree::new();
    let store = MemoryStore::open(tree.0.join("memory.sqlite")).unwrap();
    let path = tree.0.join("history.json");
    fs::write(&path,br#"[{"role":"user","content":"valid"},{"role":"assistant","content":"answer"},{"role":"user","content":"\ud800"},{"role":"assistant","content":"not SQL text"}]"#).unwrap();
    assert!(migrate_history_atomic(&store, &path, 3.0).is_err());
    assert_eq!(store.count(None).unwrap(), 0);
    assert!(
        store
            .get_state("migrated_legacy_history", None)
            .unwrap()
            .is_none()
    );
    // Paired legacy witness retains its first episode but no completion marker.
    assert!(migrate_history(&store, &path, 3.0).is_err());
    assert_eq!(store.count(None).unwrap(), 1);
    fs::write(
        &path,
        br#"[{"role":"user","content":"valid"},{"role":"assistant","content":"answer"}]"#,
    )
    .unwrap();
    assert!(matches!(
        migrate_history_atomic(&store, &path, 3.0),
        Err(reverie_store::memory::MemoryError::AmbiguousLegacyHistory)
    ));
    assert_eq!(store.count(None).unwrap(), 1);
    assert!(
        store
            .get_state("migrated_legacy_history", None)
            .unwrap()
            .is_none()
    );
    store.close().unwrap();
}
#[test]
fn atomic_history_marker_is_idempotent_across_real_concurrent_connections() {
    use std::sync::{Arc, Barrier};
    let tree = Tree::new();
    let path = tree.0.join("history.json");
    fs::write(&path,br#"[{"role":"user","content":"one"},{"role":"assistant","content":"answer"},{"role":"user","content":"two"},{"role":"assistant","content":"answer"}]"#).unwrap();
    let db = tree.0.join("memory.sqlite");
    MemoryStore::open(&db).unwrap().close().unwrap();
    let gate = Arc::new(Barrier::new(2));
    let workers = (0..2)
        .map(|_| {
            let store = MemoryStore::open(&db).unwrap();
            let path = path.clone();
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || {
                gate.wait();
                let count = migrate_history_atomic(&store, &path, 3.0).unwrap();
                store.close().unwrap();
                count
            })
        })
        .collect::<Vec<_>>();
    let mut counts = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    counts.sort_unstable();
    assert_eq!(counts, [0, 2]);
    let store = MemoryStore::open(&db).unwrap();
    assert_eq!(store.count(None).unwrap(), 2);
    assert_eq!(
        store
            .get_state("migrated_legacy_history", None)
            .unwrap()
            .as_deref(),
        Some("2")
    );
    store.close().unwrap();
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn project_scope_truncation_metadata_and_existing_lookup() {
    let tree = Tree::new();
    assert!(matches!(
        ProjectMemory::open(&tree.0, "../outside"),
        Err(ProjectMemoryError::InvalidProject)
    ));
    let first = ProjectMemory::open(&tree.0, "compiler").unwrap();
    let second = ProjectMemory::open(&tree.0, "other").unwrap();
    assert!(first.remember(" ", "source").is_err());
    assert!(first.remember("fact", " ").is_err());
    let memory = first
        .remember(
            &format!("{}truncated", "K".repeat(8000)),
            &format!("{}truncated", "s".repeat(1000)),
        )
        .unwrap();
    let view: serde_json::Value = serde_json::from_slice(memory.as_json()).unwrap();
    assert_eq!(view["text"].as_str().unwrap().chars().count(), 8000);
    assert_eq!(view["importance"], 7.0);
    assert_eq!(view["meta"]["project"], "compiler");
    assert_eq!(view["meta"]["visibility"], "project");
    assert_eq!(view["meta"]["source"].as_str().unwrap().len(), 1000);
    assert!(view.get("embedding").is_none());
    assert_eq!(first.lookup("compiler").unwrap().len(), 1);
    assert!(second.lookup("compiler").unwrap().is_empty());
    // Legacy validates the whole fact before truncating, then trims reflection.
    // An initial 8000 spaces therefore persists an empty text after truncation.
    first
        .remember(&format!("{}X", " ".repeat(8000)), "verified")
        .unwrap();
    assert_eq!(first.store().get(2).unwrap().text, "");
    first.close().unwrap();
    second.close().unwrap();
}
#[test]
fn legacy_history_import_keeps_pairing_timestamps_idle_flags_and_one_time_marker() {
    let tree = Tree::new();
    let path = tree.0.join("legacy.json");
    fs::write(&path,br#"[{"role":"assistant","content":"ignored"},{"role":"user","content":"superseded"},{"role":"user","content":"  (idle moment: quiet) "},{"role":"assistant","content":" thought "},{"role":"assistant","content":"unpaired"},{"role":"user","content":" final user "},{"role":"assistant","content":" final answer "}]"#).unwrap();
    fs::File::open(&path)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(1000))
        .unwrap();
    let store = MemoryStore::open(tree.0.join("memory.sqlite")).unwrap();
    assert_eq!(migrate_history(&store, &path, 4.0).unwrap(), 2);
    let memories = store.all(None).unwrap();
    assert_eq!(memories[0].created_at, 880.0);
    assert_eq!(memories[1].created_at, 940.0);
    assert_eq!(memories[0].importance_source, "migrated");
    assert_eq!(memories[0].importance, 4.0);
    assert!(memories[0].is_idle().unwrap());
    assert!(!memories[1].is_idle().unwrap());
    assert_eq!(
        store
            .get_state("migrated_legacy_history", None)
            .unwrap()
            .as_deref(),
        Some("2")
    );
    assert_eq!(migrate_history(&store, &path, 4.0).unwrap(), 0);
    store.close().unwrap();
}
#[test]
fn history_missing_marker_and_partial_failure_do_not_reset_existing_data() {
    let tree = Tree::new();
    let store = MemoryStore::open(tree.0.join("memory.sqlite")).unwrap();
    let path = tree.0.join("legacy.json");
    assert_eq!(migrate_history(&store, &path, 3.0).unwrap(), 0);
    assert_eq!(
        store
            .get_state("migrated_legacy_history", None)
            .unwrap()
            .as_deref(),
        Some("missing")
    );
    store.set_state("migrated_legacy_history", "").unwrap();
    fs::write(&path,br#"[{"role":"user","content":"retained"},{"role":"assistant","content":"answer"},{"role":"user","content":"\ud800"},{"role":"assistant","content":"invalid SQLite text"}]"#).unwrap();
    assert!(migrate_history(&store, &path, 3.0).is_err());
    assert_eq!(store.count(None).unwrap(), 1);
    assert_eq!(
        store
            .get_state("migrated_legacy_history", None)
            .unwrap()
            .as_deref(),
        Some("")
    );
    assert!(migrate_history(&store, &path, 3.0).is_err());
    assert_eq!(store.count(None).unwrap(), 2);
    store.close().unwrap();
}
#[test]
fn actual_python_history_timestamp_bits_match_before_and_after_unix_epoch() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/memory-history-timestamps-python.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let tree = Tree::new();
        let path = tree.0.join("history.json");
        fs::write(&path,br#"[{"role":"user","content":"one"},{"role":"assistant","content":"answer"},{"role":"user","content":"two"},{"role":"assistant","content":"answer"}]"#).unwrap();
        let ns = case["requestedNs"].as_i64().unwrap();
        let modified = if ns < 0 {
            UNIX_EPOCH - Duration::from_nanos(ns.unsigned_abs())
        } else {
            UNIX_EPOCH + Duration::from_nanos(ns as u64)
        };
        fs::File::open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let store = MemoryStore::open(tree.0.join("memory.sqlite")).unwrap();
        assert_eq!(migrate_history(&store, &path, 3.0).unwrap(), 2);
        let actual = store
            .all(None)
            .unwrap()
            .iter()
            .map(|memory| memory.created_at.to_bits())
            .collect::<Vec<_>>();
        let expected = case["createdBits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_u64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(actual, expected, "ns={ns}");
        store.close().unwrap();
    }
}
#[test]
fn project_metadata_and_truncation_keep_lossless_non_scalar_source_text() {
    use reverie_core::memory::EmbeddingText;
    let tree = Tree::new();
    let project = ProjectMemory::open(&tree.0, "compiler").unwrap();
    let mut text = vec![u32::from('x'); 8000];
    text.push(0xd800);
    let source = [u32::from('s'), 0xd800];
    let view = project
        .remember_text(
            EmbeddingText::from_codepoints(&text).unwrap(),
            EmbeddingText::from_codepoints(&source).unwrap(),
        )
        .unwrap();
    let raw = String::from_utf8(view.as_json().to_vec()).unwrap();
    assert!(raw.contains("\\ud800"));
    let memory = project.store().get(1).unwrap();
    assert_eq!(memory.text.len(), 8000);
    assert_eq!(
        memory.meta.json(),
        "{\"project\": \"compiler\", \"source\": \"s\\ud800\", \"visibility\": \"project\"}"
    );
    assert_eq!(
        project
            .lookup_text(EmbeddingText::from_codepoints(&[0xd800]).unwrap())
            .unwrap()
            .len(),
        1
    );
    project.close().unwrap();
}
