use super::super::{journal::Table, operations, receipt::Reply, validate::History};
use super::*;
use rusqlite::Connection;
use std::collections::BTreeMap;

#[test]
fn lost_close_acknowledgement_keeps_the_original_receipt() {
    let fixture = Fixture::new();
    let target = binding("a");
    let mut ledger = fixture.ledger();
    let original = reserve(&mut ledger, &target, "key", 1000).unwrap();
    crate::faults::STATE.with(|state| {
        state.borrow_mut().close = Some(crate::private_fs::CloseRole::Store);
    });
    assert_eq!(ledger.close(), Err(Error::StoreUnavailable));
    let replay = reserve(&mut fixture.ledger(), &target, "key", 1001).unwrap();
    assert_eq!(
        replay,
        json!({"replayed":true,"receipt":original["receipt"]})
    );
}

#[test]
fn real_sqlite_writer_contention_returns_unavailable_and_preserves_the_clock() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    let other = Connection::open(&fixture.file).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(
        restart(&mut ledger, 5000).err(),
        Some(Error::StoreUnavailable)
    );
    other.execute_batch("ROLLBACK").unwrap();
    assert_eq!(restart(&mut ledger, 4000).unwrap(), json!([]));
}

#[test]
fn reaching_actual_attempt_capacity_preserves_evidence_and_advances_only_the_floor() {
    let fixture = Fixture::new();
    let mut ledger = fixture.ledger();
    fill_with_closed_attempts(&mut ledger);
    let target = binding("excess");
    assert_eq!(
        reserve(&mut ledger, &target, "key", 5000).err(),
        Some(Error::StoreFull)
    );
    assert_eq!(
        reserve(&mut ledger, &target, "key", 4999).err(),
        Some(Error::ClockReversed)
    );
    assert_eq!(
        Table::Attempts.count(&ledger.db).unwrap(),
        Table::Attempts.limit()
    );
    assert_eq!(
        Table::Events.count(&ledger.db).unwrap(),
        2 * Table::Attempts.limit()
    );
}

fn fill_with_closed_attempts(ledger: &mut Ledger) {
    let txn = ledger.db.transaction().unwrap();
    let empty = History {
        floor: 1000,
        latest: BTreeMap::new(),
    };
    txn.execute("UPDATE ledger_meta SET clock_floor=1000", [])
        .unwrap();
    for n in 0..Table::Attempts.limit() {
        let target = binding(&n.to_string());
        let reply = operations::reserve(
            &txn,
            &empty,
            Reserve {
                binding: target.clone(),
                key: "reserve".to_owned(),
                now: 1000,
            },
        )
        .unwrap();
        let Reply::Attempt(item) = reply else {
            panic!("expected owned attempt");
        };
        let id = item.receipt.attempt_id.clone();
        let current = History {
            floor: 1000,
            latest: BTreeMap::from([(id.clone(), item.receipt)]),
        };
        operations::advance(
            &txn,
            &current,
            Advance {
                binding: target,
                attempt: id,
                sequence: 1,
                expected: State::Queued,
                state: State::Refused,
                reason: Reason::PolicyRefused,
                key: "refuse".to_owned(),
                now: 1000,
            },
        )
        .unwrap();
    }
    txn.commit().unwrap();
}
