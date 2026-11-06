use super::*;
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
