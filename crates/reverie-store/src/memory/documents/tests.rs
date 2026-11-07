use super::*;
std::thread_local! {
    static COMPETING_SELF: std::cell::RefCell<Option<(std::path::PathBuf,DocumentBody)>> =
        const { std::cell::RefCell::new(None) };
    static RACE_TIME:std::cell::Cell<f64>=const{std::cell::Cell::new(100.0)};
}
fn interleaving_clock() -> f64 {
    let competing = COMPETING_SELF.with(|slot| slot.borrow_mut().take());
    if let Some((path, body)) = competing {
        let competing = MemoryStore::open(path).unwrap();
        competing
            .documents(None)
            .write(&DocumentName::from_scalar_text("self"), &body, revision(1))
            .unwrap();
        competing.close().unwrap();
    }
    RACE_TIME.with(std::cell::Cell::get)
}
struct SelfRace {
    path: std::path::PathBuf,
    store: MemoryStore,
}
impl SelfRace {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "memory-stale-self-{}-{nonce}.sqlite",
            std::process::id()
        ));
        let store = MemoryStore::open(&path).unwrap();
        let documents = store.documents(None);
        documents.initialize().unwrap();
        documents
            .save_self(
                &draft(r#"{"persona":"p-old","consciousness":"A","directives":[]}"#),
                &text("initial"),
                revision(0),
            )
            .unwrap();
        Self { path, store }
    }
    fn arm(&self, body: &str) {
        COMPETING_SELF.with(|slot| {
            *slot.borrow_mut() = Some((self.path.clone(), DocumentBody::decode_json(body).unwrap()))
        });
    }
    fn documents(&self) -> MemoryDocuments<'_> {
        let mut documents = self.store.documents(None);
        documents.clock = interleaving_clock;
        documents
    }
}
impl Drop for SelfRace {
    fn drop(&mut self) {
        COMPETING_SELF.with(|slot| slot.borrow_mut().take());
        self.store.close().unwrap();
        std::fs::remove_file(&self.path).unwrap();
    }
}
#[test]
fn concurrent_self_body_cannot_reuse_stale_no_core_change_to_bypass_ballot() {
    for transactional in [false, true] {
        let race = SelfRace::new();
        let documents = race.documents();
        let model = draft(r#"{"persona":"p-old","consciousness":"A","directives":[]}"#);
        race.arm(r#"{"persona":"p-new","consciousness":"B","directives":[]}"#);
        let outcome = if transactional {
            race.store.atomic(|tx| {
                documents
                    .in_transaction(tx)?
                    .save_self(&model, &text("style"), revision(2))
            })
        } else {
            documents.save_self(&model, &text("style"), revision(2))
        };
        assert!(
            matches!(outcome, Err(MemoryError::CoreChangeRequiresVote)),
            "fresh body requires actual ballot, not stale no-change intent"
        );
        let current = documents.self_model().unwrap();
        assert_eq!(current.revision.value(), 2);
        let body: serde_json::Value = serde_json::from_slice(&current.body.as_json()).unwrap();
        assert_eq!(body["consciousness"], "B");
        assert_eq!(
            documents
                .history(&DocumentName::from_scalar_text("self"))
                .unwrap()
                .len(),
            1
        );
    }
}
#[test]
fn concurrent_persona_fallback_uses_current_writer_body_and_stale_revision_keeps_cas_priority() {
    let race = SelfRace::new();
    let documents = race.documents();
    let model = draft(r#"{"consciousness":"A","directives":[]}"#);
    race.arm(r#"{"persona":"latest persona","consciousness":"A","directives":[]}"#);
    let updated = documents
        .save_self(&model, &text("style only"), revision(2))
        .unwrap();
    assert_eq!(updated.revision.value(), 3);
    let body: serde_json::Value = serde_json::from_slice(&updated.body.as_json()).unwrap();
    assert_eq!(body["persona"], "latest persona");
    let other = SelfRace::new();
    let documents = other.documents();
    other.arm(r#"{"persona":"p-new","consciousness":"B","directives":[]}"#);
    assert!(matches!(
        documents.save_self(&model, &text("style"), revision(1)),
        Err(MemoryError::DocumentConflict {
            expected: 1,
            current: 2
        })
    ));
}
#[test]
fn concurrent_current_core_requires_real_vote_and_updates_its_actual_belief_root() {
    let race = SelfRace::new();
    let mut documents = race.store.documents(None);
    let root = race.store.add_belief("B", 5.0, None, true, None).unwrap();
    let child = race
        .store
        .add_belief("retained child", 4.0, Some(root.id), false, None)
        .unwrap();
    let model = draft(r#"{"consciousness":"A","directives":[]}"#);
    let proposal = model
        .prepare(&documents.self_model().unwrap().body, &text("proposal"))
        .unwrap()
        .core_proposal();
    let category = BallotCategory::parse("core").unwrap();
    documents.clock = week_zero;
    documents
        .vote(&category, &proposal, &text("vote one"))
        .unwrap();
    documents.clock = week_one;
    documents
        .vote(&category, &proposal, &text("vote two"))
        .unwrap();
    documents.clock = week_two;
    let vote = documents
        .vote(&category, &proposal, &text("vote three"))
        .unwrap();
    assert!(vote.outcome().approved);
    RACE_TIME.with(|time| time.set(week_two()));
    documents.clock = interleaving_clock;
    race.arm(r#"{"persona":"latest persona","consciousness":"B","directives":[]}"#);
    let result = documents
        .save_self_with_vote(&model, &text("authorized return"), revision(2), &vote)
        .unwrap();
    assert_eq!(result.revision.value(), 3);
    let beliefs = race.store.beliefs().unwrap();
    let changed = beliefs.iter().find(|belief| belief.id == root.id).unwrap();
    assert_eq!(changed.text, "A");
    assert!(!changed.protected);
    assert_eq!(
        beliefs
            .iter()
            .find(|belief| belief.id == child.id)
            .unwrap()
            .parent_id,
        Some(root.id)
    );
    assert_eq!(
        race.store.get_state("self_model_root_id", None).unwrap(),
        Some(root.id.to_string())
    );
}
#[test]
fn early_core_gate_still_precedes_write_and_read_revision_checks() {
    let race = SelfRace::new();
    let documents = race.documents();
    race.arm(r#"{"persona":"other","consciousness":"B","directives":[]}"#);
    let changed = draft(r#"{"consciousness":"C","directives":[]}"#);
    assert!(matches!(
        documents.save_self(&changed, &text("core"), revision(99)),
        Err(MemoryError::CoreChangeRequiresVote)
    ));
    assert_eq!(documents.self_model().unwrap().revision.value(), 1);
    assert!(
        COMPETING_SELF.with(|slot| slot.borrow().is_some()),
        "no writer clock/native I/O happened on early refusal"
    );
}
fn revision(value: i64) -> DocumentRevision {
    DocumentRevision::try_new(value).unwrap()
}
fn text(value: &str) -> MetadataText {
    MetadataText::from_scalar_text(value)
}
fn draft(value: &str) -> SelfModelDraft {
    SelfModelDraft::decode_json(value).unwrap()
}
#[test]
fn historical_raw_document_developer_suffixes_remain_lossless_profile_keys() {
    let store = MemoryStore::open(":memory:").unwrap();
    let documents = store.documents(None);
    documents.initialize().unwrap();
    for name in ["developer:legacy:extra", "developer:", "developer:legacy"] {
        documents
            .write(
                &DocumentName::from_scalar_text(name),
                &DocumentBody::decode_json(r#"{"role":"preserved"}"#).unwrap(),
                revision(0),
            )
            .unwrap();
    }
    assert_eq!(
        documents
            .profiles()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["", "legacy", "legacy:extra"]
    );
    store
        .atomic(|tx| {
            assert_eq!(
                documents
                    .in_transaction(tx)?
                    .profiles()?
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>(),
                ["", "legacy", "legacy:extra"]
            );
            Ok(())
        })
        .unwrap();
    store.close().unwrap();
}
#[test]
fn initial_identity_cas_preserves_outer_atomicity_and_cannot_replace_existing_self() {
    let store = MemoryStore::open(":memory:").unwrap();
    let documents = store.documents(None);
    documents.initialize().unwrap();
    let model = draft(r#"{"consciousness":"selected","directives":[]}"#);
    let result: Result<()> = store.atomic_immediate(|tx| {
        tx.add_belief("selected seed", 4.0, None, true, None)?;
        assert!(
            documents
                .in_transaction(tx)?
                .initialize_identity(&model, &text("initial"))?
        );
        assert!(!tx.db.is_autocommit());
        Err(MemoryError::Integrity)
    });
    assert!(result.is_err());
    assert!(store.beliefs().unwrap().is_empty());
    assert_eq!(documents.self_model().unwrap().revision.value(), 0);
    store
        .atomic_immediate(|tx| {
            assert!(
                documents
                    .in_transaction(tx)?
                    .initialize_identity(&model, &text("initial"))?
            );
            Ok(())
        })
        .unwrap();
    store
        .atomic_immediate(|tx| {
            assert!(!documents.in_transaction(tx)?.initialize_identity(
                &draft(r#"{"consciousness":"must not replace","directives":[]}"#),
                &text("initial")
            )?);
            Ok(())
        })
        .unwrap();
    assert_eq!(documents.self_model().unwrap().revision.value(), 1);
    store.close().unwrap();
}
#[test]
fn actual_document_cas_history_and_sql_text_failure_preserve_outer_context() {
    let store = MemoryStore::open(":memory:").unwrap();
    let documents = store.documents(None);
    documents.initialize().unwrap();
    let name = DocumentName::from_scalar_text("plan");
    let body = DocumentBody::plan(&text("first"));
    assert_eq!(
        documents
            .write(&name, &body, revision(0))
            .unwrap()
            .revision
            .value(),
        1
    );
    assert!(matches!(
        documents.write(&name, &body, revision(0)),
        Err(MemoryError::DocumentConflict { .. })
    ));
    documents
        .write(&name, &DocumentBody::plan(&text("second")), revision(1))
        .unwrap();
    let history = documents.history(&name).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].body, r#""first""#);
    let invalid = DocumentBody::decode_json(r#""\ud800""#).unwrap();
    store
        .atomic(|tx| {
            tx.set_state("prefix", "rollback")?;
            assert!(
                documents
                    .in_transaction(tx)?
                    .write(
                        &DocumentName::from_scalar_text("invalid"),
                        &invalid,
                        revision(0)
                    )
                    .is_err()
            );
            assert!(tx.db.is_autocommit());
            Ok(())
        })
        .unwrap();
    assert!(store.get_state("prefix", None).unwrap().is_none());
    store.close().unwrap();
}
fn week_zero() -> f64 {
    345600.0
}
fn week_one() -> f64 {
    345600.0 + 604800.0
}
fn week_two() -> f64 {
    345600.0 + 2.0 * 604800.0
}
#[test]
fn real_recorded_three_week_ballots_enable_same_store_self_revision_only() {
    let store = MemoryStore::open(":memory:").unwrap();
    let mut documents = store.documents(None);
    documents.clock = week_zero;
    documents.initialize().unwrap();
    let root = store.add_belief("old", 5.0, None, true, Some(1.0)).unwrap();
    let child = store
        .add_belief("child", 4.0, Some(root.id), false, Some(2.0))
        .unwrap();
    documents
        .save_self(
            &draft(r#"{"consciousness":"old","directives":[]}"#),
            &text("initial"),
            revision(0),
        )
        .unwrap();
    let proposed = draft(r#"{"consciousness":"new","directives":["one"]}"#);
    assert!(matches!(
        documents.save_self(&proposed, &text("change"), revision(1)),
        Err(MemoryError::CoreChangeRequiresVote)
    ));
    let change = proposed
        .prepare(&documents.self_model().unwrap().body, &text("change"))
        .unwrap();
    let category = BallotCategory::parse("core").unwrap();
    let proposal = change.core_proposal();
    let first = documents.vote(&category, &proposal, &text("vote")).unwrap();
    assert!(!first.outcome().approved);
    let different = BallotProposal::decode_json("{}").unwrap();
    assert!(matches!(
        documents.vote(&category, &different, &text("different")),
        Err(MemoryError::BallotConflict)
    ));
    documents.clock = week_one;
    assert!(
        !documents
            .vote(&category, &proposal, &text("vote"))
            .unwrap()
            .outcome()
            .approved
    );
    documents.clock = week_two;
    let approved = documents.vote(&category, &proposal, &text("vote")).unwrap();
    assert!(approved.outcome().approved);
    assert!(
        documents
            .save_self_with_vote(&proposed, &text("change"), revision(1), &first)
            .is_err()
    );
    let changed = store
        .atomic(|tx| {
            let mut active = documents.in_transaction(tx)?;
            let recorded = active.vote(&category, &proposal, &text("vote replay"))?;
            active.save_self_with_vote(&proposed, &text("change"), revision(1), &recorded)
        })
        .unwrap();
    assert_eq!(changed.revision.value(), 2);
    let beliefs = store.beliefs().unwrap();
    assert!(
        beliefs
            .iter()
            .any(|b| b.id == root.id && b.text == "new" && !b.protected)
    );
    assert!(
        beliefs
            .iter()
            .any(|b| b.id == child.id && b.parent_id == Some(root.id))
    );
    assert_eq!(
        documents
            .history(&DocumentName::from_scalar_text("self"))
            .unwrap()
            .len(),
        1
    );
    store.close().unwrap();
}
fn approved_ballot<'a>(store: &'a MemoryStore, proposal: &BallotProposal) -> RecordedBallot<'a> {
    let mut documents = store.documents(None);
    documents.initialize().unwrap();
    let category = BallotCategory::parse("core").unwrap();
    for clock in [week_zero as fn() -> f64, week_one] {
        documents.clock = clock;
        documents.vote(&category, proposal, &text("vote")).unwrap();
    }
    documents.clock = week_two;
    documents.vote(&category, proposal, &text("vote")).unwrap()
}
#[test]
fn recorded_ballots_refuse_foreign_store_changed_proposal_and_deleted_history() {
    let first = MemoryStore::open(":memory:").unwrap();
    let second = MemoryStore::open(":memory:").unwrap();
    let initial = draft(r#"{"consciousness":"old","directives":[]}"#);
    let proposed = draft(r#"{"consciousness":"new","directives":[]}"#);
    let mut own = first.documents(None);
    own.clock = week_two;
    own.initialize().unwrap();
    own.save_self(&initial, &text("initial"), revision(0))
        .unwrap();
    let proposal = proposed
        .prepare(&own.self_model().unwrap().body, &text("change"))
        .unwrap()
        .core_proposal();
    let recorded = approved_ballot(&first, &proposal);
    assert!(recorded.outcome().approved);
    let mut other = second.documents(None);
    other.clock = week_two;
    other.initialize().unwrap();
    other
        .save_self(&initial, &text("initial"), revision(0))
        .unwrap();
    assert!(matches!(
        other.save_self_with_vote(&proposed, &text("change"), revision(1), &recorded),
        Err(MemoryError::CoreChangeRequiresVote)
    ));
    assert!(
        second
            .atomic(|tx| {
                assert!(matches!(
                    own.in_transaction(tx),
                    Err(MemoryError::DocumentContextMismatch)
                ));
                Ok(())
            })
            .is_ok()
    );
    let changed = draft(r#"{"consciousness":"new","directives":["different"]}"#);
    assert!(matches!(
        own.save_self_with_vote(&changed, &text("change"), revision(1), &recorded),
        Err(MemoryError::CoreChangeRequiresVote)
    ));
    first
        .session(|tx| {
            tx.db
                .execute("DELETE FROM reverie_ballots WHERE week=0", [])?;
            Ok(())
        })
        .unwrap();
    assert!(matches!(
        own.save_self_with_vote(&proposed, &text("change"), revision(1), &recorded),
        Err(MemoryError::CoreChangeRequiresVote)
    ));
    assert_eq!(own.self_model().unwrap().revision.value(), 1);
    assert_eq!(other.self_model().unwrap().revision.value(), 1);
    first.close().unwrap();
    second.close().unwrap();
}
#[test]
fn pre_transaction_json_failure_preserves_outer_prefix_but_sql_bind_failure_rolls_it_back() {
    let store = MemoryStore::open(":memory:").unwrap();
    let documents = store.documents(None);
    documents.initialize().unwrap();
    let category = BallotCategory::parse("core").unwrap();
    store
        .atomic(|tx| {
            tx.set_state("before-json", "committed")?;
            let mut active = documents.in_transaction(tx)?;
            let bad_proposal = BallotProposal::decode_json(r#"["\ud800"]"#)?;
            assert!(
                active
                    .vote(&category, &bad_proposal, &text("reason"))
                    .is_err()
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store.get_state("before-json", None).unwrap().as_deref(),
        Some("committed")
    );
    store
        .atomic(|tx| {
            tx.set_state("before-sql", "rolled back")?;
            let mut active = documents.in_transaction(tx)?;
            let proposal = BallotProposal::decode_json("{}")?;
            let reason = MetadataText::from_python_text(
                reverie_core::PythonText::try_new(vec![0xd800]).unwrap(),
            );
            assert!(active.vote(&category, &proposal, &reason).is_err());
            Ok(())
        })
        .unwrap();
    assert_eq!(store.get_state("before-sql", None).unwrap(), None);
    store.close().unwrap();
}
