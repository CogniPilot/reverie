use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "memory-readiness-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn database(&self) -> PathBuf {
        self.0.join("memory.sqlite")
    }
    fn legacy(&self) -> MemoryStore {
        MemoryStore::open_with(self.database(), Arc::new(HashedEmbedder::new(8)), 0.995).unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        crate::faults::reset();
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn bytes(tree: &Tree) -> std::collections::BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(&tree.0)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_str().unwrap().to_owned(),
                std::fs::read(path).unwrap(),
            )
        })
        .collect()
}
fn admitted(tree: &Tree) -> MemoryStartupStore {
    let mut owner = MemoryStartupStore::open(tree.database()).unwrap();
    owner.preflight().unwrap();
    owner
        .admit(Arc::new(HashedEmbedder::new(8)), 0.995)
        .unwrap();
    owner
}
fn ready(tree: &Tree) {
    let mut owner = admitted(tree);
    owner.ready().unwrap();
    owner.into_ready().unwrap().close().unwrap();
}
fn collision(error: &MemoryError) -> bool {
    match error {
        MemoryError::LegacyReadinessCollision => true,
        MemoryError::Finalization { primary, secondary } => {
            collision(primary) || collision(secondary)
        }
        _ => false,
    }
}
fn changed(error: &MemoryError) -> bool {
    match error {
        MemoryError::ReadinessChanged => true,
        MemoryError::Finalization { primary, secondary } => changed(primary) || changed(secondary),
        _ => false,
    }
}
#[test]
fn same_process_rw_node_is_not_a_quiescence_or_sidecar_inertness_proof() {
    let tree = Tree::new();
    let writer = tree.legacy();
    writer
        .set_state("native_memory_startup_v1", "unknown historical value")
        .unwrap();
    let before = bytes(&tree);
    let mut owner = MemoryStartupStore::open(tree.database()).unwrap();
    let refusal = owner.preflight().unwrap_err();
    assert!(collision(&refusal), "{refusal:?}");
    assert!(owner.store().is_err());
    assert!(matches!(
        owner.admit(Arc::new(HashedEmbedder::new(8)), 0.995),
        Err(MemoryError::ReadinessUnconfirmed)
    ));
    owner.close().unwrap();
    let after = bytes(&tree);
    assert_eq!(before["memory.sqlite"], after["memory.sqlite"]);
    assert_eq!(before["memory.sqlite-wal"], after["memory.sqlite-wal"]);
    let shm_changed = before.get("memory.sqlite-shm") != after.get("memory.sqlite-shm");
    assert!(
        shm_changed,
        "pinned shared-RW-node counterexample must be exercised"
    );
    assert_eq!(
        writer
            .get_state("native_memory_startup_v1", None)
            .unwrap()
            .as_deref(),
        Some("unknown historical value")
    );
    assert_eq!(
        writer
            .session(|tx| Ok(tx.db.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='reverie_native_memory_v1'",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .unwrap(),
        0
    );
    eprintln!(
        "same-process foreign RW node: SHM changed={shm_changed}, observable stat drift reported={}; input NOT admitted, no metadata-inertness claim",
        changed(&refusal)
    );
    writer.close().unwrap();
    // Supported admission begins only after the actual foreign writer closes.
    let before = bytes(&tree);
    let mut quiesced = MemoryStartupStore::open(tree.database()).unwrap();
    assert!(matches!(
        quiesced.preflight(),
        Err(MemoryError::LegacyReadinessCollision)
    ));
    quiesced.close().unwrap();
    assert_eq!(before, bytes(&tree));
}
#[test]
fn native_backup_and_restore_keep_nonempty_legacy_rows_blobs_and_namespace() {
    let tree = Tree::new();
    let legacy = tree.legacy();
    let memory = legacy
        .add_episode(EpisodeInput::new("original source", "original answer"))
        .unwrap();
    legacy.set_state("unknown extension", "retain\0Ω").unwrap();
    legacy.close().unwrap();
    ready(&tree);
    let mut owner = admitted(&tree);
    owner.ready().unwrap();
    let store = owner.into_ready().unwrap();
    let original = store.get(memory.id).unwrap();
    let original_blob = store
        .session(|tx| {
            Ok(tx.db.query_row(
                "SELECT embedding FROM memories WHERE id=?",
                [memory.id],
                |row| row.get::<_, Vec<u8>>(0),
            )?)
        })
        .unwrap();
    let backup = tree.0.join("named-backup.sqlite");
    store.backup_to(&backup).unwrap();
    store
        .add_episode(EpisodeInput::new("later source", "later answer"))
        .unwrap();
    assert_eq!(store.count(None).unwrap(), 2);
    store.restore_from(&backup).unwrap();
    assert_eq!(store.count(None).unwrap(), 1);
    let restored = store.get(memory.id).unwrap();
    assert_eq!(restored.id, original.id);
    assert_eq!(restored.embedding, original.embedding);
    assert_eq!(
        store
            .session(|tx| Ok(tx.db.query_row(
                "SELECT embedding FROM memories WHERE id=?",
                [memory.id],
                |row| row.get::<_, Vec<u8>>(0)
            )?))
            .unwrap(),
        original_blob
    );
    assert_eq!(restored.created_at, original.created_at);
    assert_eq!(
        store
            .get_state("unknown extension", None)
            .unwrap()
            .as_deref(),
        Some("retain\0Ω")
    );
    store.close().unwrap();
    let mut profile = MemoryReadProfile::open_native(tree.database()).unwrap();
    assert_eq!(
        profile.native_readiness().unwrap().unwrap().phase(),
        MemoryStartupPhase::Ready
    );
    profile.close().unwrap();
}
#[test]
fn every_historical_marker_value_refuses_before_any_database_or_sidecar_mutation() {
    for (startup, model) in [
        (Some("owner state Ω"), None),
        (None, Some("owner model")),
        (Some("ready"), Some("hashed-v1-8")),
        (Some("profile-pending"), Some("")),
    ] {
        let tree = Tree::new();
        let store = tree.legacy();
        store
            .add_episode(EpisodeInput::new(
                "retained original user",
                "retained answer",
            ))
            .unwrap();
        store.set_state("unknown extension", "preserve\0Ω").unwrap();
        if let Some(value) = startup {
            store.set_state("native_memory_startup_v1", value).unwrap();
        }
        if let Some(value) = model {
            store
                .set_state("native_memory_embed_model_v1", value)
                .unwrap();
        }
        store.close().unwrap();
        std::fs::write(tree.0.join("profile.md"), b"owner profile").unwrap();
        std::fs::write(tree.0.join("config.json"), b"owner config").unwrap();
        let before = bytes(&tree);
        let mut owner = MemoryStartupStore::open(tree.database()).unwrap();
        assert!(matches!(
            owner.preflight(),
            Err(MemoryError::LegacyReadinessCollision)
        ));
        assert!(owner.store().is_err());
        assert!(matches!(owner.shutdown(), ShutdownStatus::Complete));
        assert_eq!(before, bytes(&tree));
        // Ordinary legacy compatibility remains available and retains values.
        let reader = MemoryReadProfile::open(tree.database()).unwrap();
        assert_eq!(
            reader
                .get_state("native_memory_startup_v1")
                .unwrap()
                .as_deref(),
            startup
        );
        let mut reader = reader;
        reader.close().unwrap();
    }
}
#[test]
fn genuine_reinitialization_keeps_all_legacy_rows_ids_blobs_and_new_singleton_rowid() {
    let tree = Tree::new();
    let store = tree.legacy();
    let memory = store
        .add_episode(EpisodeInput::new("old memory", "old answer"))
        .unwrap();
    store.set_state("extension", "opaque Ω").unwrap();
    let before = store.all(None).unwrap();
    store.close().unwrap();
    ready(&tree);
    for _ in 0..2 {
        let mut owner = admitted(&tree);
        assert_eq!(
            owner.store().unwrap().get(memory.id).unwrap().embedding,
            before[0].embedding
        );
        owner.profile_pending().unwrap();
        owner.ready().unwrap();
        let store = owner.into_ready().unwrap();
        assert_eq!(
            store.get_state("extension", None).unwrap().as_deref(),
            Some("opaque Ω")
        );
        assert!(
            store
                .get_state("native_memory_startup_v1", None)
                .unwrap()
                .is_none()
        );
        store.close().unwrap();
        let db = Connection::open(tree.database()).unwrap();
        assert_eq!(
            db.query_row("SELECT rowid FROM reverie_native_memory_v1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        db.close().unwrap();
    }
    let mut profile = MemoryReadProfile::open_native(tree.database()).unwrap();
    let observed = profile.native_readiness().unwrap().unwrap();
    assert_eq!(observed.phase(), MemoryStartupPhase::Ready);
    assert_eq!(observed.model(), Some("hashed-v1-8"));
    profile.close().unwrap();
}
#[test]
fn pending_owners_reopen_without_matching_string_adoption_and_foreign_schema_refuses() {
    let tree = Tree::new();
    let mut first = admitted(&tree);
    first.profile_pending().unwrap();
    first.close().unwrap();
    let mut profile = MemoryReadProfile::open_native(tree.database()).unwrap();
    assert_eq!(
        profile.native_readiness().unwrap().unwrap().phase(),
        MemoryStartupPhase::ProfilePending
    );
    profile.close().unwrap();
    ready(&tree);
    let store = tree.legacy();
    store
        .set_state(
            "native_memory_startup_v1",
            "unrelated after genuine new owner",
        )
        .unwrap();
    store.close().unwrap();
    ready(&tree);
    let store = tree.legacy();
    assert_eq!(
        store
            .get_state("native_memory_startup_v1", None)
            .unwrap()
            .as_deref(),
        Some("unrelated after genuine new owner")
    );
    store.close().unwrap();
    let db = Connection::open(tree.database()).unwrap();
    db.execute_batch("CREATE TRIGGER foreign_native_owner AFTER UPDATE ON reverie_native_memory_v1 BEGIN SELECT 1;END;").unwrap();
    db.close().unwrap();
    let before = bytes(&tree);
    let mut owner = MemoryStartupStore::open(tree.database()).unwrap();
    assert!(matches!(
        owner.preflight(),
        Err(MemoryError::ForeignReadinessNamespace)
    ));
    owner.close().unwrap();
    assert_eq!(before, bytes(&tree));
}
#[test]
fn malformed_native_rows_and_unsupported_versions_never_get_normalized() {
    for change in [
        "DELETE FROM reverie_native_memory_v1",
        "UPDATE reverie_native_memory_v1 SET format=2",
        "UPDATE reverie_native_memory_v1 SET format=x'00'",
        "UPDATE reverie_native_memory_v1 SET phase='unknown'",
        "UPDATE reverie_native_memory_v1 SET phase='ready',model=NULL",
        "UPDATE reverie_native_memory_v1 SET model=x'ff'",
        "UPDATE reverie_native_memory_v1 SET phase='initializing'",
        "UPDATE reverie_native_memory_v1 SET phase='profile-pending'",
    ] {
        let tree = Tree::new();
        ready(&tree);
        let db = Connection::open(tree.database()).unwrap();
        db.execute_batch(change).unwrap();
        db.close().unwrap();
        let before = bytes(&tree);
        let mut owner = MemoryStartupStore::open(tree.database()).unwrap();
        assert!(
            matches!(
                owner.preflight(),
                Err(MemoryError::MalformedReadinessMetadata
                    | MemoryError::UnsupportedReadinessVersion)
            ),
            "{change}"
        );
        owner.close().unwrap();
        assert_eq!(before, bytes(&tree));
    }
}
#[test]
fn consumed_anchor_close_is_sticky_refused_after_actual_sqlite_close() {
    let tree = Tree::new();
    let mut owner = admitted(&tree);
    owner.ready().unwrap();
    let store = owner.into_ready().unwrap();
    crate::faults::STATE
        .with(|state| state.borrow_mut().close = Some(crate::private_fs::CloseRole::Data));
    assert!(matches!(store.shutdown(), ShutdownStatus::Refused(_)));
    assert!(store.connection.lock().unwrap().is_none());
    assert!(matches!(
        store.shutdown(),
        ShutdownStatus::Refused(MemoryError::ReadinessUnconfirmed)
    ));
}
#[test]
fn source_rebinding_after_preflight_cannot_admit_or_mutate_the_foreign_database() {
    let tree = Tree::new();
    tree.legacy().close().unwrap();
    let mut owner = MemoryStartupStore::open(tree.database()).unwrap();
    owner.preflight().unwrap();
    std::fs::rename(tree.database(), tree.0.join("original.sqlite")).unwrap();
    std::fs::write(tree.database(), b"foreign source stays exactly unchanged").unwrap();
    assert!(matches!(
        owner.admit(Arc::new(HashedEmbedder::new(8)), 0.995),
        Err(MemoryError::ReadinessChanged)
    ));
    owner.close().unwrap();
    assert_eq!(
        std::fs::read(tree.database()).unwrap(),
        b"foreign source stays exactly unchanged"
    );
}
#[test]
fn finite_main_only_preflight_refuses_rewrite_and_sidecar_arrival_without_fallback() {
    for after_preflight in [false, true] {
        let tree = Tree::new();
        tree.legacy().close().unwrap();
        assert!(!tree.0.join("memory.sqlite-wal").exists());
        let mut owner = MemoryStartupStore::open(tree.database()).unwrap();
        if after_preflight {
            owner.preflight().unwrap();
        }
        std::fs::write(
            tree.0.join("memory.sqlite-wal"),
            b"foreign arrival preserved exactly",
        )
        .unwrap();
        let before = bytes(&tree);
        let result = if after_preflight {
            owner.admit(Arc::new(HashedEmbedder::new(8)), 0.995)
        } else {
            owner.preflight()
        };
        assert!(matches!(result, Err(MemoryError::ReadinessChanged)));
        owner.close().unwrap();
        assert_eq!(before, bytes(&tree));
    }
    let tree = Tree::new();
    tree.legacy().close().unwrap();
    let mut owner = MemoryStartupStore::open(tree.database()).unwrap();
    std::fs::write(
        tree.database(),
        b"same held inode rewritten before observation",
    )
    .unwrap();
    let before = bytes(&tree);
    assert!(matches!(
        owner.preflight(),
        Err(MemoryError::ReadinessChanged)
    ));
    owner.close().unwrap();
    assert_eq!(before, bytes(&tree));
}
#[test]
fn actual_writer_rechecks_owned_state_before_first_schema_or_native_write() {
    let tree = Tree::new();
    ready(&tree);
    let mut owner = MemoryStartupStore::open(tree.database()).unwrap();
    owner.preflight().unwrap();
    let path = tree.database();
    crate::faults::STATE.with(|state| {
        state.borrow_mut().hook = Some(Box::new(move |point, _| {
            if point == crate::faults::Point::MemoryStartupBeforeWriter {
                let competing = Connection::open(&path).unwrap();
                competing
                    .execute(
                        "UPDATE reverie_native_memory_v1 SET phase='profile-pending',model=NULL",
                        [],
                    )
                    .unwrap();
                competing.close().unwrap();
            }
            Ok(())
        }))
    });
    assert!(matches!(
        owner.admit(Arc::new(HashedEmbedder::new(8)), 0.995),
        Err(MemoryError::ReadinessChanged)
    ));
    owner.close().unwrap();
    let mut profile = MemoryReadProfile::open_native(tree.database()).unwrap();
    assert_eq!(
        profile.native_readiness().unwrap().unwrap().phase(),
        MemoryStartupPhase::ProfilePending
    );
    profile.close().unwrap();
}
