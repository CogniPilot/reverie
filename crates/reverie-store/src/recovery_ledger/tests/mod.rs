mod behavior;
mod capacity;
mod integrity;

use super::contract::{Advance, Binding, Operation, Reason, Reserve, Restart, State};
use super::receipt::id;
use super::{Error, Ledger, Request, Response, Result};
use serde_json::{Value, json};
use std::fs::{self, DirBuilder};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;

struct Fixture {
    root: PathBuf,
    file: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("reverie-recovery-{}", id().unwrap()));
        DirBuilder::new().mode(0o700).create(&root).unwrap();
        let file = root.join("owner ledger.sqlite");
        Self { root, file }
    }

    fn ledger(&self) -> Ledger {
        Ledger::open(&self.file).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn binding(suffix: &str) -> Binding {
    Binding {
        employee_id: format!("employee-{suffix}"),
        goal_id: format!("goal-{suffix}"),
        goal_generation: 1,
        session_id: format!("session-{suffix}"),
        session_generation: 1,
        transition_sequence: 0,
    }
}

fn reserve(ledger: &mut Ledger, target: &Binding, key: &str, now: i64) -> Result<Value> {
    ledger
        .execute(Request(Operation::Reserve(Reserve {
            binding: target.clone(),
            key: key.to_owned(),
            now,
        })))
        .map(value)
}

fn transition(
    ledger: &mut Ledger,
    prior: &Value,
    state: State,
    reason: Reason,
    key: &str,
    now: i64,
) -> Result<Value> {
    let input = Advance {
        binding: serde_json::from_value(prior["binding"].clone()).unwrap(),
        attempt: prior["attemptId"].as_str().unwrap().to_owned(),
        sequence: prior["sequence"].as_i64().unwrap(),
        expected: serde_json::from_value(prior["state"].clone()).unwrap(),
        state,
        reason,
        key: key.to_owned(),
        now,
    };
    ledger
        .execute(Request(Operation::Advance(input)))
        .map(value)
}

fn restart(ledger: &mut Ledger, now: i64) -> Result<Value> {
    ledger
        .execute(Request(Operation::Restart(Restart { now })))
        .map(value)
}

fn value(response: Response) -> Value {
    serde_json::to_value(response).unwrap()
}

fn refused(ledger: &mut Ledger, target: &Binding, key: &str, now: i64) {
    let item = reserve(ledger, target, key, now).unwrap();
    assert_eq!(item["receipt"]["state"], "QUEUED");
    let done = transition(
        ledger,
        &item["receipt"],
        State::Refused,
        Reason::PolicyRefused,
        key,
        now + 1,
    )
    .unwrap();
    assert_eq!(done["receipt"]["state"], "REFUSED");
}
