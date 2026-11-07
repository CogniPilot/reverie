use reverie_core::memory::HashedEmbedder;
use reverie_store::memory::{EpisodeInput, MemoryStore, RetrievalOptions};
use rusqlite::{Connection, types::ValueRef};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "memory-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn fixture(&self) -> PathBuf {
        let path = self.0.join("memory.sqlite");
        fs::write(&path, include_bytes!("fixtures/memory-store-python.sqlite")).unwrap();
        path
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn expected() -> Value {
    serde_json::from_str(include_str!("fixtures/memory-store-python.json")).unwrap()
}
fn hex(raw: &[u8]) -> String {
    raw.iter().map(|v| format!("{v:02x}")).collect()
}
fn quoted(raw: &str) -> String {
    format!("\"{}\"", raw.replace('"', "\"\""))
}
fn snapshot(path: &Path) -> Value {
    let db = Connection::open(path).unwrap();
    let names = {
        let mut statement = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let mut tables = serde_json::Map::new();
    let mut rows = serde_json::Map::new();
    for name in names {
        let mut statement = db
            .prepare(&format!("PRAGMA table_info({})", quoted(&name)))
            .unwrap();
        let columns=statement.query_map([],|row|Ok(json!({"name":row.get::<_,String>(1)?,"type":row.get::<_,String>(2)?,"notnull":row.get::<_,i64>(3)?,"default":row.get::<_,Option<String>>(4)?,"pk":row.get::<_,i64>(5)?}))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        tables.insert(name.clone(), json!(columns));
        let mut statement = db
            .prepare(&format!("SELECT * FROM {} ORDER BY rowid", quoted(&name)))
            .unwrap();
        let count = statement.column_count();
        let mut cursor = statement.query([]).unwrap();
        let mut values = Vec::new();
        while let Some(row) = cursor.next().unwrap() {
            let mut cells = Vec::new();
            for i in 0..count {
                cells.push(match row.get_ref(i).unwrap() {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(v) => json!(std::str::from_utf8(v).unwrap()),
                    ValueRef::Blob(v) => json!({"blob":hex(v)}),
                });
            }
            values.push(cells);
        }
        rows.insert(name, json!(values));
    }
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    json!({"tables":tables,"rows":rows,"userVersion":version})
}
#[test]
fn actual_python_database_reads_views_ranking_claims_and_original_blobs_without_reembedding() {
    let tree = Tree::new();
    let path = tree.fixture();
    let before = snapshot(&path);
    let expected = expected();
    assert_eq!(before, expected["sqlite"]);
    let store = MemoryStore::open_with(&path, Arc::new(HashedEmbedder::new(64)), 0.995).unwrap();
    assert_eq!(store.count(None).unwrap(), 4);
    assert_eq!(store.count(Some("")).unwrap(), 4);
    assert_eq!(
        store.get_state("retained", None).unwrap().as_deref(),
        Some("existing")
    );
    assert_eq!(
        store
            .get_state("empty", Some("default"))
            .unwrap()
            .as_deref(),
        Some("")
    );
    for (memory, view) in store
        .all(None)
        .unwrap()
        .iter()
        .zip(expected["viewsJson"].as_array().unwrap())
    {
        assert_eq!(memory.as_dict_json(), view.as_str().unwrap().as_bytes());
    }
    let retrieved = store
        .retrieve(
            "compiler rust",
            RetrievalOptions {
                now: Some(2000.0),
                ..Default::default()
            },
        )
        .unwrap();
    for (memory, view) in retrieved
        .iter()
        .zip(expected["retrievedJson"].as_array().unwrap())
    {
        assert_eq!(memory.as_dict_json(), view.as_str().unwrap().as_bytes());
    }
    assert_eq!(store.beliefs().unwrap().len(), 2);
    assert!(store.answered("synthetic:answered").unwrap());
    assert!(
        store
            .is_voice_claimed("KELVIN İSTANBUL AΣ!", 600.0, Some(2000.0))
            .unwrap()
    );
    assert_eq!(store.reembed_all().unwrap(), 0);
    store.close().unwrap();
    assert_eq!(snapshot(&path), before);
}
#[test]
fn named_backup_and_restore_preserve_every_table_counter_and_blob() {
    let tree = Tree::new();
    let original = tree.fixture();
    let store =
        MemoryStore::open_with(&original, Arc::new(HashedEmbedder::new(64)), 0.995).unwrap();
    let snapshot_path = tree.0.join("snapshot.sqlite");
    store.backup_to(&snapshot_path).unwrap();
    assert_eq!(snapshot(&snapshot_path), expected()["sqlite"]);
    let target = MemoryStore::open_with(
        tree.0.join("restored.sqlite"),
        Arc::new(HashedEmbedder::new(64)),
        0.995,
    )
    .unwrap();
    target
        .add_episode(EpisodeInput::new(
            "temporary unrelated row",
            "before selected restore",
        ))
        .unwrap();
    target.restore_from(&snapshot_path).unwrap();
    assert_eq!(target.count(None).unwrap(), 4);
    target.close().unwrap();
    assert_eq!(
        snapshot(&tree.0.join("restored.sqlite")),
        expected()["sqlite"]
    );
    store.close().unwrap();
}
fn legacy_schema(path: &Path) {
    let connection = Connection::open(path).unwrap();
    let column = String::from_utf8(vec![106, 105, 110, 120, 95, 116, 101, 120, 116]).unwrap();
    connection
        .execute_batch(&format!(
            "ALTER TABLE memories RENAME COLUMN assistant_text TO {column};PRAGMA user_version=0"
        ))
        .unwrap();
    connection.close().unwrap();
}
#[test]
fn legacy_column_migration_and_staged_restore_preserve_rows_blobs_and_source_snapshot() {
    let tree = Tree::new();
    let source = tree.fixture();
    legacy_schema(&source);
    let before = snapshot(&source);
    let target = MemoryStore::open(tree.0.join("restored.sqlite")).unwrap();
    target.restore_from(&source).unwrap();
    assert_eq!(target.count(None).unwrap(), 4);
    target.close().unwrap();
    assert_eq!(
        snapshot(&tree.0.join("restored.sqlite")),
        expected()["sqlite"]
    );
    assert_eq!(snapshot(&source), before);
    let migrated =
        MemoryStore::open_with(&source, Arc::new(HashedEmbedder::new(64)), 0.995).unwrap();
    assert_eq!(migrated.count(None).unwrap(), 4);
    migrated.close().unwrap();
    assert_eq!(snapshot(&source), expected()["sqlite"]);
}
#[test]
fn ambiguous_legacy_columns_refuse_without_rewriting_rows_or_schema() {
    let tree = Tree::new();
    let path = tree.fixture();
    let connection = Connection::open(&path).unwrap();
    let column = String::from_utf8(vec![106, 105, 110, 120, 95, 116, 101, 120, 116]).unwrap();
    connection
        .execute_batch(&format!("ALTER TABLE memories ADD COLUMN {column} TEXT"))
        .unwrap();
    connection.close().unwrap();
    let before = snapshot(&path);
    assert!(matches!(
        MemoryStore::open(&path),
        Err(reverie_store::memory::MemoryError::AmbiguousAssistantColumns)
    ));
    assert_eq!(snapshot(&path), before);
}
