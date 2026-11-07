//! Reuses the sealed, nonempty fixture produced by unchanged legacy APIs.
//! All SQLite connections here are closed before native lifecycle admission.
use super::*;
use reverie_store::memory::{MemoryReadProfile, MemoryStartupStore};

fn original_cells(path: &Path) -> Value {
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let schema = {
        let mut query = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name!='reverie_native_memory_v1' ORDER BY type,name").unwrap();
        query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let mut data = serde_json::Map::new();
    for (_, name, _, _) in schema.iter().filter(|entry| entry.0 == "table") {
        data.insert(name.clone(), rows(&db, name));
    }
    let version: i64 = db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    db.close().unwrap();
    json!({"schema":schema,"rows":data,"version":version})
}
fn rows(db: &Connection, name: &str) -> Value {
    let mut query = db
        .prepare(&format!(
            "SELECT rowid,* FROM {} ORDER BY rowid",
            quoted(name)
        ))
        .unwrap();
    let count = query.column_count();
    let mut cursor = query.query([]).unwrap();
    let mut rows = Vec::new();
    while let Some(row) = cursor.next().unwrap() {
        let cells = (0..count)
            .map(|index| match row.get_ref(index).unwrap() {
                ValueRef::Null => json!(["null"]),
                ValueRef::Integer(value) => json!(["integer", value]),
                ValueRef::Real(value) => json!(["real-bits", value.to_bits()]),
                ValueRef::Text(value) => json!(["text-bytes", hex(value)]),
                ValueRef::Blob(value) => json!(["blob", hex(value)]),
            })
            .collect::<Vec<_>>();
        rows.push(cells);
    }
    json!(rows)
}
#[test]
fn native_readiness_preserves_python_documents_claims_history_extensions_and_vector_bytes() {
    let tree = Tree::new();
    let path = tree.0.join("memory.sqlite");
    fs::write(
        &path,
        include_bytes!("../fixtures/memory-startup-python.sqlite"),
    )
    .unwrap();
    let provenance: Value =
        serde_json::from_str(include_str!("../fixtures/memory-startup-python.json")).unwrap();
    assert_eq!(
        provenance["hashes"]["memory.sqlite"],
        "4f3d8482be76220180650f597b0c9142e3716e8de1ac9c6811bca7e019e1af69"
    );
    let original = original_cells(&path);
    assert_eq!(original["rows"]["memories"].as_array().unwrap().len(), 4);
    assert!(
        original["rows"]["reverie_documents"]
            .as_array()
            .unwrap()
            .len()
            >= 3
    );
    assert!(
        !original["rows"]["future_extension"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let profile = tree.0.join("profile.md");
    let config = tree.0.join("instance.json");
    fs::write(&profile, b"original selected profile\0 untouched").unwrap();
    fs::write(&config, b"original selected config\0 untouched").unwrap();
    for _ in 0..2 {
        initialize(&path);
        assert_eq!(original_cells(&path), original);
        let bytes = fs::read(&path).unwrap();
        recall(&path);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        // Normal readonly WAL IPC/read marks are allowed. This source has no
        // writer and recall must not append any persistent WAL frames.
        assert_eq!(
            fs::metadata(path.with_extension("sqlite-wal"))
                .map(|info| info.len())
                .unwrap_or(0),
            0
        );
        assert_eq!(
            fs::read(&profile).unwrap(),
            b"original selected profile\0 untouched"
        );
        assert_eq!(
            fs::read(&config).unwrap(),
            b"original selected config\0 untouched"
        );
    }
}
fn initialize(path: &Path) {
    let mut owner = MemoryStartupStore::open(path).unwrap();
    owner.preflight().unwrap();
    owner
        .admit(Arc::new(HashedEmbedder::new(8)), 0.995)
        .unwrap();
    owner.profile_pending().unwrap();
    owner.ready().unwrap();
    owner.into_ready().unwrap().close().unwrap();
}
fn recall(path: &Path) {
    let profile = MemoryReadProfile::open_native(path).unwrap();
    assert_eq!(
        profile.native_readiness().unwrap().unwrap().model(),
        Some("hashed-v1-8")
    );
    let reader = profile
        .bind(Arc::new(HashedEmbedder::new(8)), 0.995)
        .unwrap();
    let memories = reader
        .retrieve(
            "synthetic capsule anchor memory preserves existing vector bytes",
            RetrievalOptions {
                now: Some(1700002000.0),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(memories.iter().any(|memory| memory.id == 42
        && memory.text == "synthetic capsule anchor memory preserves existing vector bytes"));
    reader.close().unwrap();
}
