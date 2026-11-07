use super::*;

fn deferred_constraint_store() -> MemoryStore {
    let store = MemoryStore::open(":memory:").unwrap();
    store.session(|tx| {
        // Synthetic extension schema only. Production keeps legacy FK=OFF.
        tx.db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TRIGGER deferred_memory AFTER INSERT ON memories BEGIN INSERT INTO child VALUES(NEW.id); END;")?;
        Ok(())
    }).unwrap();
    store
}

#[test]
fn own_transaction_rolls_back_failed_commit_but_explicit_atomic_keeps_it_open() {
    let store = deferred_constraint_store();
    assert!(
        store
            .add_episode(EpisodeInput::new("user", "assistant"))
            .is_err()
    );
    store
        .session(|tx| {
            assert!(tx.db.is_autocommit());
            assert_eq!(tx.count(None)?, 0);
            Ok(())
        })
        .unwrap();
    assert!(
        store
            .atomic(|tx| tx.add_episode(EpisodeInput::new("user", "assistant")))
            .is_err()
    );
    store
        .session(|tx| {
            assert!(!tx.db.is_autocommit());
            assert_eq!(tx.count(None)?, 1);
            tx.rollback()
        })
        .unwrap();
    assert_eq!(store.count(None).unwrap(), 0);
    store.close().unwrap();
}
#[test]
fn voice_leading_non_scalar_text_is_removed_before_real_sql_binding() {
    let store = MemoryStore::open(":memory:").unwrap();
    let leading = [0xd800, 32, 0x212a, 0x45, 0x4c, 0x56, 0x49, 0x4e];
    let text = EmbeddingText::from_codepoints(&leading).unwrap();
    store.claim_voice_text(text, Some(100.0)).unwrap();
    assert!(
        store
            .is_voice_claimed("kelvin", 600.0, Some(100.0))
            .unwrap()
    );
    assert!(
        store
            .is_voice_claimed_text(text, 600.0, Some(100.0))
            .unwrap()
    );
    let interior = [u32::from('A'), 0xd800];
    assert!(
        store
            .claim_voice_text(
                EmbeddingText::from_codepoints(&interior).unwrap(),
                Some(100.0)
            )
            .is_err()
    );
    store.close().unwrap();
}
#[test]
fn prune_connection_context_rolls_back_commit_failure_even_inside_atomic() {
    let store = deferred_constraint_store();
    store
        .session(|tx| {
            tx.db.execute_batch("DROP TRIGGER deferred_memory")?;
            Ok(())
        })
        .unwrap();
    store
        .add_dream(DreamInput::new("first", "calm", &[]))
        .unwrap();
    store
        .add_dream(DreamInput::new("second", "calm", &[]))
        .unwrap();
    store.session(|tx| {tx.db.execute_batch("CREATE TRIGGER deferred_prune AFTER DELETE ON memories BEGIN INSERT INTO child VALUES(OLD.id); END;")?;Ok(())}).unwrap();
    store
        .atomic(|tx| {
            tx.set_state("prefix", "must roll back")?;
            assert!(tx.prune_dream_summaries(1).is_err());
            assert!(tx.db.is_autocommit());
            Ok(())
        })
        .unwrap();
    assert_eq!(store.count(Some("dream")).unwrap(), 2);
    assert_eq!(store.get_state("prefix", None).unwrap(), None);
    store.close().unwrap();
}
