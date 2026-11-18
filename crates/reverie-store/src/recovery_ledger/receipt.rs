use super::contract::{Binding, Dimension, Reason, State};
use super::{Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(transparent)]
pub struct Response(pub(super) Reply);

#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum Reply {
    Attempt(Single<Attempt>),
    Budget(Single<Budget>),
    Restart(Vec<Attempt>),
}

#[derive(Serialize)]
pub(super) struct Single<T> {
    pub(super) replayed: bool,
    pub(super) receipt: T,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Action {
    None,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum AttemptKind {
    ResumeAttempt,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Attempt {
    #[serde(rename = "schema_version")]
    pub(super) schema_version: i64,
    receipt_type: AttemptKind,
    pub(super) receipt_id: String,
    pub(super) attempt_id: String,
    pub(super) binding: Binding,
    pub(super) sequence: i64,
    pub(super) state: State,
    pub(super) reason: Reason,
    pub(super) created_at_ms: i64,
    automatic_action: Action,
}

impl Attempt {
    pub(super) fn queued(attempt: String, binding: Binding, now: i64) -> Result<Self> {
        Ok(Self {
            schema_version: 1,
            receipt_type: AttemptKind::ResumeAttempt,
            receipt_id: id()?,
            attempt_id: attempt,
            binding,
            sequence: 1,
            state: State::Queued,
            reason: Reason::Queued,
            created_at_ms: now,
            automatic_action: Action::None,
        })
    }

    pub(super) fn advance(&self, state: State, reason: Reason, now: i64) -> Result<Self> {
        Ok(Self {
            receipt_id: id()?,
            sequence: self.sequence + 1,
            state,
            reason,
            created_at_ms: now,
            ..self.clone()
        })
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum BudgetKind {
    ResumeBudgetRefused,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Budget {
    #[serde(rename = "schema_version")]
    pub(super) schema_version: i64,
    receipt_type: BudgetKind,
    pub(super) receipt_id: String,
    pub(super) dimension: Dimension,
    pub(super) subject: String,
    pub(super) blocked_until_ms: i64,
    pub(super) created_at_ms: i64,
    automatic_action: Action,
}

impl Budget {
    pub(super) fn new(dimension: Dimension, subject: &str, until: i64, now: i64) -> Result<Self> {
        Ok(Self {
            schema_version: 1,
            receipt_type: BudgetKind::ResumeBudgetRefused,
            receipt_id: id()?,
            dimension,
            subject: subject.to_owned(),
            blocked_until_ms: until,
            created_at_ms: now,
            automatic_action: Action::None,
        })
    }
}

pub(super) fn id() -> Result<String> {
    crate::private_fs::random_uuid()
        .map(|uuid| uuid.replace('-', ""))
        .map_err(|_| Error::StoreUnavailable)
}
