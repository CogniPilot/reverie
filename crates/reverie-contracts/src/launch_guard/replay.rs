use super::{Id, Positive, Receipt, Snapshot, sha256};
use std::collections::BTreeMap;

const MAX_ENTRIES: usize = 256;

#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Key {
    employee: Id,
    session: Id,
    session_generation: Positive,
    goal: Id,
    goal_generation: Positive,
    idempotency_key: Id,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayError {
    Conflict,
    Full,
}

impl std::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Conflict => "IDEMPOTENCY_CONFLICT",
            Self::Full => "GUARD_API_UNAVAILABLE",
        })
    }
}

/// Bounded synthetic replay; no persistence, scheduling, or authorization.
#[derive(Default)]
pub struct Replay {
    rows: BTreeMap<Key, (String, Receipt)>,
}

impl Replay {
    pub fn evaluate(&mut self, input: &Snapshot) -> Result<Receipt, ReplayError> {
        let request = &input.0.request;
        let key = Key {
            employee: request.employee_id.clone(),
            session: request.session_id.clone(),
            session_generation: request.session_generation,
            goal: request.goal_id.clone(),
            goal_generation: request.goal_generation,
            idempotency_key: request.idempotency_key.clone(),
        };
        let digest = sha256(request);
        if let Some((prior_digest, receipt)) = self.rows.get(&key) {
            return if digest == *prior_digest {
                Ok(receipt.clone())
            } else {
                Err(ReplayError::Conflict)
            };
        }
        if self.rows.len() >= MAX_ENTRIES {
            return Err(ReplayError::Full);
        }
        let receipt = input.evaluate();
        self.rows.insert(key, (digest, receipt.clone()));
        Ok(receipt)
    }
}
