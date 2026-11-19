use super::super::contract::Dimension;
use super::super::journal::MAX_ACTIVE;
use super::*;
use std::sync::Barrier;
use std::thread;

#[test]
fn replays_original_receipts_and_fences_stale_idempotency_and_bindings() {
    let fixture = Fixture::new();
    let target = binding("a");
    let mut ledger = fixture.ledger();
    let first = reserve(&mut ledger, &target, "request", 1000).unwrap();
    let submitted = transition(
        &mut ledger,
        &first["receipt"],
        State::Submitted,
        Reason::SubmissionConfirmed,
        "step",
        1100,
    )
    .unwrap();
    ledger.close().unwrap();
    let mut ledger = fixture.ledger();
    let replay = reserve(&mut ledger, &target, "request", 1200).unwrap();
    assert_eq!(replay, json!({"replayed":true,"receipt":first["receipt"]}));
    let replay = transition(
        &mut ledger,
        &first["receipt"],
        State::Submitted,
        Reason::SubmissionConfirmed,
        "step",
        1300,
    )
    .unwrap();
    assert_eq!(
        replay,
        json!({"replayed":true,"receipt":submitted["receipt"]})
    );
    assert_eq!(
        transition(
            &mut ledger,
            &first["receipt"],
            State::Refused,
            Reason::PolicyRefused,
            "step",
            1500,
        )
        .err(),
        Some(Error::IdempotencyConflict)
    );
    assert_eq!(
        transition(
            &mut ledger,
            &first["receipt"],
            State::Refused,
            Reason::PolicyRefused,
            "new",
            1600,
        )
        .err(),
        Some(Error::CasStale)
    );
    let mut changed = first["receipt"].clone();
    changed["binding"]["goal_generation"] = json!(2);
    assert_eq!(
        transition(
            &mut ledger,
            &changed,
            State::Refused,
            Reason::PolicyRefused,
            "new",
            1700,
        )
        .err(),
        Some(Error::BindingChanged)
    );
    assert_eq!(
        reserve(&mut ledger, &target, "request", 1699).err(),
        Some(Error::ClockReversed)
    );
}

#[test]
fn quota_counts_failures_per_stable_dimension_and_deduplicates_the_window_report() {
    for dimension in Dimension::ALL {
        let fixture = Fixture::new();
        let mut ledger = fixture.ledger();
        for number in 0..3 {
            let target = budget_target(dimension, number);
            refused(
                &mut ledger,
                &target,
                &format!("try-{number}"),
                1000 + number * 10,
            );
        }
        let target = budget_target(dimension, 4);
        let alert = reserve(&mut ledger, &target, "new", 1030).unwrap();
        assert_eq!(alert["replayed"], false);
        assert_eq!(alert["receipt"]["dimension"], dimension.column());
        assert_eq!(alert["receipt"]["blockedUntilMs"], 1801000);
        let repeated = reserve(&mut ledger, &target, "other", 1800999).unwrap();
        assert_eq!(
            repeated,
            json!({"replayed":true,"receipt":alert["receipt"]})
        );
        let fresh = reserve(&mut ledger, &target, "after", 1801000).unwrap();
        assert_eq!(fresh["receipt"]["state"], "QUEUED");
    }
}

fn budget_target(dimension: Dimension, number: i64) -> Binding {
    let mut target = binding(&number.to_string());
    match dimension {
        Dimension::Employee => target.employee_id = "same-worker".to_owned(),
        Dimension::Goal => target.goal_id = "same-goal".to_owned(),
        Dimension::Session => target.session_id = "same-session".to_owned(),
    }
    target.goal_generation = number + 1;
    target.session_generation = number + 1;
    target
}

#[test]
fn restart_fences_queued_submitted_and_started_after_expiry_and_replacement() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    for phase in 1..=3 {
        seed_stage(&mut ledger, phase);
    }
    ledger.close().unwrap();
    let mut ledger = fixture.ledger();
    let reconciled = restart(&mut ledger, 2000).unwrap();
    let rows = reconciled.as_array().unwrap();
    assert_eq!(rows.len(), 3);
    for row in rows {
        assert_eq!(row["state"], "UNCERTAIN");
        assert_eq!(row["reason"], "PROCESS_RESTART");
        assert_eq!(row["automaticAction"], "NONE");
    }
    assert_eq!(restart(&mut ledger, 2000).unwrap(), json!([]));
    let mut successor = binding("1");
    successor.goal_id = "replacement-goal".to_owned();
    successor.session_id = "replacement-session".to_owned();
    successor.session_generation = 2;
    assert_eq!(
        reserve(&mut ledger, &successor, "new", 1803000).err(),
        Some(Error::UnresolvedAttempt),
    );
}

fn seed_stage(ledger: &mut Ledger, phase: u32) {
    let item = reserve(ledger, &binding(&phase.to_string()), "initial", 1000).unwrap();
    if phase > 1 {
        let sent = transition(
            ledger,
            &item["receipt"],
            State::Submitted,
            Reason::SubmissionConfirmed,
            "restart",
            1000,
        )
        .unwrap();
        if phase > 2 {
            transition(
                ledger,
                &sent["receipt"],
                State::TurnStarted,
                Reason::TurnConfirmed,
                "turn",
                1000,
            )
            .unwrap();
        }
    }
}

#[test]
fn accepts_full_success_path_and_refuses_terminal_transitions() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    let mut prior =
        reserve(&mut ledger, &binding("a"), "request", 1000).unwrap()["receipt"].clone();
    for (state, reason, sequence) in [
        (State::Submitted, Reason::SubmissionConfirmed, 2),
        (State::TurnStarted, Reason::TurnConfirmed, 3),
        (State::ProgressObserved, Reason::ProgressConfirmed, 4),
    ] {
        prior = transition(
            &mut ledger,
            &prior,
            state,
            reason,
            &format!("step-{sequence}"),
            1001,
        )
        .unwrap()["receipt"]
            .clone();
        assert_eq!(prior["sequence"], sequence);
    }
    assert_eq!(
        transition(
            &mut ledger,
            &prior,
            State::Failed,
            Reason::TurnFailed,
            "again",
            1002,
        )
        .err(),
        Some(Error::TransitionInvalid)
    );
    assert_eq!(restart(&mut ledger, 1002).unwrap(), json!([]));
}

#[test]
fn respects_active_queue_limit_for_independent_bindings() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    for number in 0..MAX_ACTIVE {
        let result = reserve(&mut ledger, &binding(&number.to_string()), "request", 1000).unwrap();
        assert_eq!(result["receipt"]["state"], "QUEUED");
    }
    assert_eq!(
        reserve(&mut ledger, &binding("excess"), "request", 5000).err(),
        Some(Error::QueueFull),
    );
    assert_eq!(restart(&mut ledger, 4999).err(), Some(Error::ClockReversed));
    assert_eq!(
        restart(&mut ledger, 5000)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        MAX_ACTIVE
    );
}

#[test]
fn concurrent_connections_create_one_receipt_for_an_identical_request() {
    let fixture = Fixture::new();
    fixture.ledger().close().unwrap();
    let barrier = Barrier::new(4);
    let results = thread::scope(|scope| {
        (0..4)
            .map(|_| {
                scope.spawn(|| {
                    let ledger = Ledger::open(&fixture.file);
                    barrier.wait();
                    let mut ledger = ledger.unwrap();
                    reserve(&mut ledger, &binding("a"), "request", 1000).unwrap()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|task| task.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        results
            .iter()
            .filter(|item| item["replayed"] == false)
            .count(),
        1
    );
    assert!(
        results
            .iter()
            .all(|result| result["receipt"] == results[0]["receipt"])
    );
}

#[test]
fn refuses_malformed_keys_and_clock_values_without_creating_an_attempt() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    for key in [".key", "a.b", "a:b", &"a".repeat(97)] {
        assert_eq!(
            reserve(&mut ledger, &binding("a"), key, 1000).err(),
            Some(Error::InputInvalid)
        );
    }
    for subject in ["a/b", "é", "a\n", "", &"a".repeat(101)] {
        let mut malformed = binding("a");
        malformed.goal_id = subject.to_owned();
        assert_eq!(
            reserve(&mut ledger, &malformed, "key", 1000).err(),
            Some(Error::InputInvalid)
        );
    }
    for now in [-1, (1 << 53) - 1] {
        assert_eq!(
            reserve(&mut ledger, &binding("a"), "key", now).err(),
            Some(Error::InputInvalid)
        );
    }
    let mut valid = binding("a");
    valid.employee_id = format!(".{}", "a".repeat(99));
    valid.goal_id = "goal:part.1".to_owned();
    let accepted = reserve(&mut ledger, &valid, &"x".repeat(96), 0).unwrap();
    assert_eq!(
        accepted["receipt"]["binding"],
        serde_json::to_value(valid).unwrap()
    );
}
