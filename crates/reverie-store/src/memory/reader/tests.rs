use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "memory-read-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn open(path: &Path, dims: usize) -> Result<MemoryReader> {
    MemoryReader::open_with(path, Arc::new(HashedEmbedder::new(dims)), 0.995)
}
#[test]
fn read_uses_live_wal_and_original_vectors_without_touch_or_model_reselection() {
    let tree = Tree::new();
    let path = tree.0.join("memory.sqlite");
    let store = MemoryStore::open_with(&path, Arc::new(HashedEmbedder::new(8)), 0.995).unwrap();
    let memory = store
        .add_episode(EpisodeInput::new("retained text", "original answer"))
        .unwrap();
    store.set_state("sentinel", "retained").unwrap();
    let before = store
        .session(|tx| {
            Ok((
                tx.db.total_changes(),
                tx.db
                    .query_row("SELECT embedding FROM memories", [], |row| {
                        row.get::<_, Vec<u8>>(0)
                    })?,
            ))
        })
        .unwrap();
    let reader = open(&path, 8).unwrap();
    assert_eq!(
        reader.get_state("sentinel").unwrap().as_deref(),
        Some("retained")
    );
    let result = reader
        .retrieve(
            "retained text",
            RetrievalOptions {
                now: Some(9000.0),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].id, memory.id);
    assert_eq!(result[0].embedding, memory.embedding);
    assert_eq!(
        store.get(memory.id).unwrap().last_accessed,
        memory.last_accessed
    );
    let connection = reader.connection.lock().unwrap();
    let error = connection
        .as_ref()
        .unwrap()
        .execute("UPDATE state SET value='changed'", [])
        .unwrap_err();
    assert_eq!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::ReadOnly)
    );
    drop(connection);
    let other = open(&path, 16).unwrap();
    assert!(
        other
            .retrieve("retained text", Default::default())
            .unwrap()
            .is_empty()
    );
    other.close().unwrap();
    reader.close().unwrap();
    let after = store
        .session(|tx| {
            Ok((
                tx.db.total_changes(),
                tx.db
                    .query_row("SELECT embedding FROM memories", [], |row| {
                        row.get::<_, Vec<u8>>(0)
                    })?,
            ))
        })
        .unwrap();
    assert_eq!(before, after);
    store.close().unwrap();
}
#[test]
fn missing_partial_and_legacy_databases_are_not_created_or_migrated() {
    let tree = Tree::new();
    let missing = tree.0.join("missing/memory.sqlite");
    assert!(matches!(
        open(&missing, 8),
        Err(MemoryError::NotInitialized)
    ));
    assert!(!missing.parent().unwrap().exists());
    assert!(matches!(
        open(Path::new(":memory:"), 8),
        Err(MemoryError::NotInitialized)
    ));
    let partial = tree.0.join("partial.sqlite");
    let db = Connection::open(&partial).unwrap();
    db.execute_batch("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('kept');")
        .unwrap();
    assert!(matches!(
        open(&partial, 8),
        Err(MemoryError::NotInitialized)
    ));
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    db.close().unwrap();
    let legacy = tree.0.join("legacy.sqlite");
    let store = MemoryStore::open(&legacy).unwrap();
    store.session(|tx| { tx.db.execute_batch(&format!("ALTER TABLE memories RENAME COLUMN assistant_text TO {LEGACY_ASSISTANT_COLUMN}; PRAGMA user_version=0"))?; Ok(()) }).unwrap();
    store.close().unwrap();
    assert!(matches!(open(&legacy, 8), Err(MemoryError::NeedsMigration)));
    let db = Connection::open(&legacy).unwrap();
    assert_eq!(
        db.pragma_query_value::<i64, _>(None, "user_version", |row| row.get(0))
            .unwrap(),
        0
    );
    db.close().unwrap();
}
