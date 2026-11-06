use reverie_core::memory::{Embedder, EmbeddingError, EmbeddingKind, HashedEmbedder};
use reverie_store::memory::{DreamInput, EpisodeInput, MemoryError, MemoryStore};
use rusqlite::Connection;
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc, Barrier,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "memory-behavior-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn store(&self) -> MemoryStore {
        MemoryStore::open_with(
            self.0.join("memory.sqlite"),
            Arc::new(HashedEmbedder::new(16)),
            0.995,
        )
        .unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn refusal<T>() -> Result<T, MemoryError> {
    Err(MemoryError::EmptyBelief)
}
#[test]
fn nested_atomic_rollback_commit_escape_and_panic_recovery() {
    let tree = Tree::new();
    let store = tree.store();
    let result = store.atomic(|tx| {
        tx.set_state("outer", "rolled back")?;
        tx.add_episode(EpisodeInput::new("user", "assistant"))?;
        tx.add_belief("belief", 5.0, None, false, Some(1.0))?;
        refusal::<()>()
    });
    assert!(result.is_err());
    assert_eq!(store.count(None).unwrap(), 0);
    assert!(store.beliefs().unwrap().is_empty());
    assert_eq!(store.get_state("outer", None).unwrap(), None);
    store
        .atomic(|tx| {
            tx.set_state("outer", "committed")?;
            assert!(
                tx.atomic(|inner| {
                    inner.set_state("caught", "also committed")?;
                    refusal::<()>()
                })
                .is_err()
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store.get_state("caught", None).unwrap().as_deref(),
        Some("also committed")
    );
    // These explicit legacy commit points escape the outer atomic rollback,
    // including touch/reembed calls that have no selected rows.
    for operation in [
        "claim",
        "voice",
        "importance",
        "touch-empty",
        "reembed-empty",
        "prune-empty",
    ] {
        let result = store.atomic(|tx| {
            tx.set_state(operation, "before explicit commit")?;
            match operation {
                "claim" => {
                    assert!(tx.claim_message("source", Some(100.0))?);
                }
                "voice" => tx.claim_voice("transcript", Some(100.0))?,
                "importance" => tx.set_importance(999, 7.0, "model")?,
                "touch-empty" => tx.touch(&[], Some(100.0))?,
                "reembed-empty" => {
                    assert_eq!(tx.reembed_all()?, 0);
                }
                "prune-empty" => {
                    assert_eq!(tx.prune_dream_summaries(1)?, 0);
                }
                _ => unreachable!(),
            }
            tx.set_state("after", "rolled back")?;
            refusal::<()>()
        });
        assert!(result.is_err());
        assert!(store.get_state(operation, None).unwrap().is_some());
        assert_eq!(store.get_state("after", None).unwrap(), None);
    }
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = store.atomic::<()>(|tx| {
            tx.set_state("panic", "rollback")?;
            panic!("controlled panic")
        });
    }));
    assert!(panic.is_err());
    assert_eq!(store.get_state("panic", None).unwrap(), None);
    store.set_state("still", "usable").unwrap();
    store.close().unwrap();
    store.close().unwrap();
    assert!(matches!(store.count(None), Err(MemoryError::Closed)));
}
#[test]
fn belief_direct_children_and_dream_summary_retention() {
    let tree = Tree::new();
    let store = tree.store();
    let parent = store
        .add_belief("parent", 5.0, None, false, Some(1.0))
        .unwrap();
    let child = store
        .add_belief("protected child", 8.0, Some(parent.id), true, Some(2.0))
        .unwrap();
    let grandchild = store
        .add_belief("grandchild", 4.0, Some(child.id), false, Some(3.0))
        .unwrap();
    assert!(matches!(
        store.remove_belief(child.id),
        Err(MemoryError::ProtectedBelief(_))
    ));
    store.remove_belief(parent.id).unwrap();
    // Legacy SQL deletes the selected parent and direct children only, even
    // when a direct child is protected. Preserve it; do not invent recursion.
    assert_eq!(
        store
            .beliefs()
            .unwrap()
            .iter()
            .map(|v| v.id)
            .collect::<Vec<_>>(),
        [grandchild.id]
    );
    let mut input = DreamInput::new("  waking summary  ", "calm", &[]);
    input.created_at = Some(1.0);
    let first = store.add_dream(input).unwrap();
    assert_eq!(first.text, "waking summary");
    assert!(first.meta.json().contains("summary_only"));
    store.release_dream(first.id, true).unwrap();
    let mut input = DreamInput::new("newer", "calm", &[]);
    input.created_at = Some(2.0);
    let second = store.add_dream(input).unwrap();
    assert_eq!(store.prune_dream_summaries(0).unwrap(), 1);
    assert_eq!(store.latest_dream().unwrap().unwrap().id, second.id);
    assert_eq!(store.count_dreams_since(2.0).unwrap(), 0);
    store.close().unwrap();
}
struct SlowEmbedder {
    entered: Arc<Barrier>,
    release: Arc<Barrier>,
}
impl Embedder for SlowEmbedder {
    fn name(&self) -> reverie_core::memory::EmbeddingText<'_> {
        reverie_core::memory::EmbeddingText::from_scalar_text("hashed-v1-16")
    }
    fn dimensions(&self) -> usize {
        16
    }
    fn embed_text(
        &self,
        text: reverie_core::memory::EmbeddingText<'_>,
        kind: EmbeddingKind,
    ) -> Result<Vec<f64>, EmbeddingError> {
        self.entered.wait();
        self.release.wait();
        HashedEmbedder::new(16).embed_text(text, kind)
    }
}
#[test]
fn provider_wait_does_not_hold_database_mutex_outside_atomic() {
    let tree = Tree::new();
    let store = Arc::new(tree.store());
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    store
        .set_embedder(Arc::new(SlowEmbedder {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
        }))
        .unwrap();
    let writer = Arc::clone(&store);
    let thread =
        std::thread::spawn(move || writer.add_episode(EpisodeInput::new("user", "assistant")));
    entered.wait();
    let (sender, receiver) = std::sync::mpsc::channel();
    let reader = Arc::clone(&store);
    let read_thread = std::thread::spawn(move || {
        let result = (|| {
            reader.set_state("concurrent", "readable")?;
            reader.claim_voice("spoken", Some(100.0))?;
            reader.count(None)
        })();
        sender.send(result).unwrap();
    });
    let result = receiver.recv_timeout(Duration::from_secs(2));
    release.wait();
    thread.join().unwrap().unwrap();
    read_thread.join().unwrap();
    assert_eq!(result.unwrap().unwrap(), 0);
    store.close().unwrap();
}
#[test]
fn independent_connections_claim_once_and_install_one_external_episode() {
    let tree = Tree::new();
    let first = tree.store();
    let second = tree.store();
    let start = Arc::new(Barrier::new(2));
    let other_start = Arc::clone(&start);
    let thread = std::thread::spawn(move || {
        other_start.wait();
        let claimed = second.claim_message("same-source", Some(100.0)).unwrap();
        let memory = second
            .add_external_episode("same-external", "other", "answer", "private")
            .unwrap();
        second.close().unwrap();
        (claimed, memory.id)
    });
    start.wait();
    let claimed = first.claim_message("same-source", Some(100.0)).unwrap();
    let memory = first
        .add_external_episode("same-external", "first", "answer", "private")
        .unwrap();
    let other = thread.join().unwrap();
    assert_ne!(claimed, other.0);
    assert_eq!(memory.id, other.1);
    assert_eq!(first.count(None).unwrap(), 1);
    first.close().unwrap();
}
#[test]
fn snapshot_alias_refusals_and_pinned_destination_lock_are_bounded() {
    let tree = Tree::new();
    let store = tree.store();
    store.set_state("retained", "unchanged").unwrap();
    let path = store.path();
    for alias in [path.to_owned(), tree.0.join("hard.sqlite")] {
        if alias != path {
            fs::hard_link(path, &alias).unwrap();
        }
        assert!(matches!(
            store.backup_to(&alias),
            Err(MemoryError::SameDatabase)
        ));
        assert!(matches!(
            store.restore_from(&alias),
            Err(MemoryError::SameDatabase)
        ));
    }
    #[cfg(unix)]
    {
        let alias = tree.0.join("symbolic.sqlite");
        std::os::unix::fs::symlink(path, &alias).unwrap();
        assert!(matches!(
            store.backup_to(&alias),
            Err(MemoryError::SameDatabase)
        ));
        assert!(matches!(
            store.restore_from(&alias),
            Err(MemoryError::SameDatabase)
        ));
    }
    let destination = tree.0.join("locked.sqlite");
    let db = Connection::open(&destination).unwrap();
    db.execute_batch(
        "CREATE TABLE retained(value);INSERT INTO retained VALUES ('unchanged');BEGIN EXCLUSIVE",
    )
    .unwrap();
    let start = Instant::now();
    assert!(matches!(
        store.backup_to(&destination),
        Err(MemoryError::BackupUncertain(_))
    ));
    assert!(start.elapsed() < Duration::from_secs(5));
    db.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        db.query_row("SELECT value FROM retained", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "unchanged"
    );
    db.close().unwrap();
    assert_eq!(
        store.get_state("retained", None).unwrap().as_deref(),
        Some("unchanged")
    );
    store.close().unwrap();
}
#[test]
fn nine_actual_python_transaction_transcripts_match_durable_results() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/memory-transactions-python.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let operation = case["operation"].as_str().unwrap();
        let tree = Tree::new();
        let store = tree.store();
        let mut input = DreamInput::new("summary", "calm", &[]);
        input.created_at = Some(1.0);
        let dream = store.add_dream(input).unwrap();
        let belief = store
            .add_belief("belief", 5.0, None, false, Some(1.0))
            .unwrap();
        let result = store.atomic(|tx| {
            tx.set_state(operation, "before explicit commit")?;
            match operation {
                "normal" => {}
                "claim" => {
                    tx.claim_message("source", Some(100.0))?;
                }
                "voice" => tx.claim_voice("transcript", Some(100.0))?,
                "importance" => tx.set_importance(999, 7.0, "model")?,
                "touch-empty" => tx.touch(&[], Some(100.0))?,
                "reembed-empty" => {
                    tx.reembed_all()?;
                }
                "prune-empty" => {
                    tx.prune_dream_summaries(1)?;
                }
                "release" => tx.release_dream(dream.id, true)?,
                "remove-belief" => tx.remove_belief(belief.id)?,
                _ => panic!("unrecognized sealed vector"),
            }
            tx.set_state("after", "rolled back")?;
            refusal::<()>()
        });
        assert!(result.is_err());
        assert_eq!(
            serde_json::to_value(store.get_state(operation, None).unwrap()).unwrap(),
            case["prefix"],
            "{operation}"
        );
        assert_eq!(
            serde_json::to_value(store.get_state("after", None).unwrap()).unwrap(),
            case["after"],
            "{operation}"
        );
        assert_eq!(store.count(None).unwrap(), case["count"].as_i64().unwrap());
        assert_eq!(
            store.answered("source").unwrap(),
            case["answered"].as_bool().unwrap()
        );
        assert_eq!(
            store
                .is_voice_claimed("transcript", 600.0, Some(100.0))
                .unwrap(),
            case["voice"].as_bool().unwrap()
        );
        assert_eq!(
            store.beliefs().unwrap().len() as u64,
            case["beliefs"].as_u64().unwrap()
        );
        assert_eq!(
            store
                .get(dream.id)
                .unwrap()
                .meta
                .json()
                .contains("\"released\": true"),
            case["released"].as_bool().unwrap()
        );
        store.close().unwrap();
    }
}
#[test]
fn locked_restore_preserves_destination_and_bad_snapshot_is_not_installed() {
    let tree = Tree::new();
    let store = tree.store();
    store.set_state("destination", "retained").unwrap();
    let source = MemoryStore::open(tree.0.join("source.sqlite")).unwrap();
    source.set_state("replacement", "selected").unwrap();
    source.close().unwrap();
    let lock = Connection::open(store.path()).unwrap();
    lock.execute_batch("BEGIN IMMEDIATE").unwrap();
    let started = Instant::now();
    assert!(matches!(
        store.restore_from(tree.0.join("source.sqlite")),
        Err(MemoryError::RestoreUncertain(_))
    ));
    assert!(started.elapsed() < Duration::from_secs(5));
    lock.execute_batch("ROLLBACK").unwrap();
    lock.close().unwrap();
    assert_eq!(
        store.get_state("destination", None).unwrap().as_deref(),
        Some("retained")
    );
    assert_eq!(store.get_state("replacement", None).unwrap(), None);
    fs::write(tree.0.join("invalid.sqlite"), b"not a database").unwrap();
    assert!(store.restore_from(tree.0.join("invalid.sqlite")).is_err());
    assert_eq!(
        store.get_state("destination", None).unwrap().as_deref(),
        Some("retained")
    );
    store.close().unwrap();
}
#[test]
fn actual_python_rankings_include_ties_negative_slices_nonfinite_weights_and_model_filter() {
    use reverie_store::memory::{ReflectionInput, RetrievalOptions};
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/memory-ranking-python.json")).unwrap();
    for group in fixture["groups"].as_array().unwrap() {
        let tree = Tree::new();
        let store = tree.store();
        let count = group["count"].as_u64().unwrap();
        for index in 0..count {
            let mut input = ReflectionInput::new(
                "compiler rust parser",
                if index % 3 == 0 { 10.0 } else { 3.0 },
                &[],
            );
            input.created_at = Some((index % 5) as f64 * 100.0);
            store.add_reflection(input).unwrap();
        }
        for case in group["cases"].as_array().unwrap() {
            let weights = std::array::from_fn(|index| {
                case["weights"][index]
                    .as_str()
                    .unwrap()
                    .parse::<f64>()
                    .unwrap()
            });
            let options = RetrievalOptions {
                now: Some(1000.0),
                k: case["k"].as_i64().unwrap(),
                weights,
                combine: case["combine"].as_str().unwrap(),
                ..Default::default()
            };
            let actual = store
                .retrieve("compiler", options)
                .unwrap()
                .into_iter()
                .map(|memory| memory.id)
                .collect::<Vec<_>>();
            let expected = case["ids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_i64().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(
                actual, expected,
                "count={count}, weights={weights:?}, case={case}"
            );
        }
        store
            .set_embedder(Arc::new(HashedEmbedder::new(32)))
            .unwrap();
        assert!(
            store
                .retrieve("compiler", RetrievalOptions::default())
                .unwrap()
                .is_empty()
        );
        store.close().unwrap();
    }
}
struct FailingReembed {
    calls: std::sync::atomic::AtomicUsize,
}
impl Embedder for FailingReembed {
    fn name(&self) -> reverie_core::memory::EmbeddingText<'_> {
        reverie_core::memory::EmbeddingText::from_scalar_text("synthetic-reembed-fixture")
    }
    fn dimensions(&self) -> usize {
        32
    }
    fn embed_text(
        &self,
        text: reverie_core::memory::EmbeddingText<'_>,
        kind: EmbeddingKind,
    ) -> Result<Vec<f64>, EmbeddingError> {
        if self.calls.fetch_add(1, Ordering::Relaxed) == 1 {
            return Err(EmbeddingError::Backend("controlled test failure".into()));
        }
        HashedEmbedder::new(32).embed_text(text, kind)
    }
}
#[test]
fn partial_reembedding_is_not_implicitly_committed_or_reset() {
    for later_commit in [false, true] {
        let tree = Tree::new();
        let store = tree.store();
        store
            .add_episode(EpisodeInput::new("first", "answer"))
            .unwrap();
        store
            .add_episode(EpisodeInput::new("second", "answer"))
            .unwrap();
        store
            .set_embedder(Arc::new(FailingReembed {
                calls: std::sync::atomic::AtomicUsize::new(0),
            }))
            .unwrap();
        assert!(store.reembed_all().is_err());
        assert_eq!(
            store.get(1).unwrap().embed_model,
            "synthetic-reembed-fixture"
        );
        assert_eq!(store.get(2).unwrap().embed_model, "hashed-v1-16");
        let reader = Connection::open(store.path()).unwrap();
        assert_eq!(
            reader
                .query_row("SELECT embed_model FROM memories WHERE id=1", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "hashed-v1-16"
        );
        reader.close().unwrap();
        if later_commit {
            store
                .set_state("explicit later write", "commits source prefix")
                .unwrap();
        }
        store.close().unwrap();
        let reopened = tree.store();
        assert_eq!(
            reopened.get(1).unwrap().embed_model,
            if later_commit {
                "synthetic-reembed-fixture"
            } else {
                "hashed-v1-16"
            }
        );
        assert_eq!(reopened.get(2).unwrap().embed_model, "hashed-v1-16");
        reopened.close().unwrap();
    }
}
#[test]
fn excluded_corrupt_embedding_and_metadata_are_skipped_before_row_decode() {
    use reverie_store::memory::RetrievalOptions;
    let tree = Tree::new();
    let store = tree.store();
    let good = store
        .add_episode(EpisodeInput::new("good", "answer"))
        .unwrap();
    let bad = store
        .add_episode(EpisodeInput::new("bad", "answer"))
        .unwrap();
    let writer = Connection::open(store.path()).unwrap();
    writer
        .execute(
            "UPDATE memories SET embedding=x'01',meta='invalid JSON' WHERE id=?",
            [bad.id],
        )
        .unwrap();
    writer.close().unwrap();
    assert!(store.retrieve("good", RetrievalOptions::default()).is_err());
    let memories = store
        .retrieve(
            "good",
            RetrievalOptions {
                exclude_ids: &[bad.id],
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        memories.iter().map(|memory| memory.id).collect::<Vec<_>>(),
        [good.id]
    );
    assert!(store.get(bad.id).is_err());
    store.close().unwrap();
}
#[test]
fn snapshot_apis_refuse_sqlite_ephemeral_names_before_touching_destination() {
    let tree = Tree::new();
    let store = tree.store();
    store.set_state("existing", "preserved").unwrap();
    for path in ["", ":memory:"] {
        assert!(matches!(
            store.backup_to(path),
            Err(MemoryError::EphemeralSnapshot)
        ));
        assert!(matches!(
            store.restore_from(path),
            Err(MemoryError::EphemeralSnapshot)
        ));
    }
    assert_eq!(
        store.get_state("existing", None).unwrap().as_deref(),
        Some("preserved")
    );
    store.close().unwrap();
}
#[test]
fn legacy_connection_defaults_preserve_extension_rows_and_securely_delete_payloads() {
    let tree = Tree::new();
    let store = tree.store();
    let marker = "synthetic-memory-deletion-marker-593e82";
    let recall = marker.repeat(1000);
    let mut input = DreamInput::new(&recall, "calm", &[]);
    input.created_at = Some(1.0);
    let old = store.add_dream(input).unwrap();
    let extension = Connection::open(store.path()).unwrap();
    extension.execute_batch("CREATE TABLE retained_extension(memory_id INTEGER REFERENCES memories(id), value TEXT)").unwrap();
    extension
        .execute(
            "INSERT INTO retained_extension VALUES (?,'retained')",
            [old.id],
        )
        .unwrap();
    extension.close().unwrap();
    let mut input = DreamInput::new("new retained summary", "calm", &[]);
    input.created_at = Some(2.0);
    store.add_dream(input).unwrap();
    assert_eq!(store.prune_dream_summaries(1).unwrap(), 1);
    let path = store.path().to_owned();
    store.close().unwrap();
    let extension = Connection::open(&path).unwrap();
    assert_eq!(
        extension
            .query_row("SELECT value FROM retained_extension", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "retained"
    );
    extension.close().unwrap();
    assert!(
        !fs::read(path)
            .unwrap()
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
    );
}
