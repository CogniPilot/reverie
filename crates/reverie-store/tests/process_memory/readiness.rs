//! Actual killed SQLite writers. These fixture SQL statements are not a
//! product callback, operator file editor or native initialization authority.
use super::{Tree, child, wait_ready};
use reverie_core::{memory::HashedEmbedder, shutdown::ShutdownStatus};
use reverie_store::memory::{EpisodeInput, MemoryError, MemoryStartupStore, MemoryStore};
use rusqlite::Connection;
use std::{
    collections::BTreeMap, fs, os::unix::process::ExitStatusExt, path::Path, sync::Arc, thread,
    time::Duration,
};
mod root_case;

pub(super) fn writer(root: &Path, mode: &str, index: &str) {
    if mode == "readiness-root-control" {
        root_case::observe(root);
        return;
    }
    let db = Connection::open(root.join("memory.sqlite")).unwrap();
    match mode {
        "readiness-wal" => {
            db.execute_batch("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;INSERT INTO state(key,value) VALUES('native_memory_startup_v1','committed collision only in WAL');").unwrap();
        }
        "readiness-pending" => {
            db.execute_batch("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;UPDATE reverie_native_memory_v1 SET phase='profile-pending',model=NULL;").unwrap();
        }
        "readiness-hot" => {
            db.execute_batch("PRAGMA journal_mode=DELETE;CREATE TABLE readiness_payload(id INTEGER PRIMARY KEY,data BLOB);").unwrap();
            for id in 0..40 {
                db.execute(
                    "INSERT INTO readiness_payload VALUES(?,zeroblob(2048))",
                    [id],
                )
                .unwrap();
            }
            db.execute_batch("PRAGMA cache_size=1;BEGIN IMMEDIATE;UPDATE readiness_payload SET data=randomblob(4096);INSERT INTO state(key,value) VALUES('native_memory_startup_v1','uncommitted collision');").unwrap();
        }
        _ => panic!("closed readiness writer mode"),
    }
    fs::write(root.join(format!("ready-{index}")), mode).unwrap();
    loop {
        thread::park_timeout(Duration::from_secs(60));
    }
}
fn bytes(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(root)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_str().unwrap().to_owned(),
                fs::read(path).unwrap(),
            )
        })
        .collect()
}
fn seeded(tree: &Tree) {
    let store = MemoryStore::open_with(
        tree.0.join("memory.sqlite"),
        Arc::new(HashedEmbedder::new(8)),
        0.995,
    )
    .unwrap();
    store
        .add_episode(EpisodeInput::new("existing memory", "existing answer"))
        .unwrap();
    store.set_state("unknown extension", "keep Ω").unwrap();
    store.close().unwrap();
    fs::write(tree.0.join("profile.md"), b"selected original profile").unwrap();
    fs::write(tree.0.join("instance.json"), b"selected original config").unwrap();
}
fn killed(tree: &Tree, mode: &str) {
    let mut writer = child(&tree.0, mode, 0);
    wait_ready(&tree.0, 0, &mut writer);
    writer.0.kill().unwrap();
    assert_eq!(writer.0.wait().unwrap().signal(), Some(9));
}
#[test]
fn committed_wal_only_collision_refuses_without_checkpoint_or_close_side_effects() {
    let tree = Tree::new();
    seeded(&tree);
    killed(&tree, "readiness-wal");
    assert!(tree.0.join("memory.sqlite-wal").is_file());
    let before = bytes(&tree.0);
    let mut owner = MemoryStartupStore::open(tree.0.join("memory.sqlite")).unwrap();
    assert!(matches!(
        owner.preflight(),
        Err(MemoryError::LegacyReadinessCollision)
    ));
    assert!(matches!(owner.shutdown(), ShutdownStatus::Complete));
    assert_eq!(before, bytes(&tree.0));
}
#[test]
fn hot_rollback_and_missing_shm_are_unverified_before_any_mutating_open() {
    for mode in ["readiness-hot", "readiness-wal"] {
        let tree = Tree::new();
        seeded(&tree);
        killed(&tree, mode);
        if mode == "readiness-hot" {
            let journal = fs::read(tree.0.join("memory.sqlite-journal")).unwrap();
            assert_eq!(
                &journal[..8],
                &[0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]
            );
        } else {
            fs::remove_file(tree.0.join("memory.sqlite-shm")).unwrap();
        }
        let before = bytes(&tree.0);
        match MemoryStartupStore::open(tree.0.join("memory.sqlite")) {
            Err(MemoryError::ReadinessRecoveryRequired) => (),
            Ok(mut owner) => {
                assert!(matches!(
                    owner.preflight(),
                    Err(MemoryError::ReadinessObservationUnavailable(_))
                ));
                owner.close().unwrap();
            }
            other => panic!("unexpected safe recovery disposition: {other:?}"),
        }
        assert_eq!(before, bytes(&tree.0));
    }
}
#[test]
fn genuine_native_pending_only_in_wal_reopens_and_retains_original_vectors_and_extensions() {
    let tree = Tree::new();
    seeded(&tree);
    let mut owner = MemoryStartupStore::open(tree.0.join("memory.sqlite")).unwrap();
    owner.preflight().unwrap();
    owner
        .admit(Arc::new(HashedEmbedder::new(8)), 0.995)
        .unwrap();
    owner.ready().unwrap();
    owner.into_ready().unwrap().close().unwrap();
    let store = MemoryStore::open(tree.0.join("memory.sqlite")).unwrap();
    let expected = store.all(None).unwrap();
    store.close().unwrap();
    killed(&tree, "readiness-pending");
    let mut owner = MemoryStartupStore::open(tree.0.join("memory.sqlite")).unwrap();
    owner.preflight().unwrap();
    owner
        .admit(Arc::new(HashedEmbedder::new(8)), 0.995)
        .unwrap();
    owner.ready().unwrap();
    let store = owner.into_ready().unwrap();
    let actual = store.all(None).unwrap();
    assert_eq!(actual.len(), expected.len());
    assert_eq!(actual[0].id, expected[0].id);
    assert_eq!(actual[0].embedding, expected[0].embedding);
    assert_eq!(
        store
            .get_state("unknown extension", None)
            .unwrap()
            .as_deref(),
        Some("keep Ω")
    );
    store.close().unwrap();
    assert_eq!(
        fs::read(tree.0.join("profile.md")).unwrap(),
        b"selected original profile"
    );
    assert_eq!(
        fs::read(tree.0.join("instance.json")).unwrap(),
        b"selected original config"
    );
}
