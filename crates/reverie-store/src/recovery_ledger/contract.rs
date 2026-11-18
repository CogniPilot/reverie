use super::{Error, Result, WINDOW_MS, require};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_INTEGER: i64 = (1 << 53) - 1;

#[derive(Deserialize)]
#[serde(transparent)]
pub struct Request(pub(super) Operation);

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(super) enum Operation {
    Reserve(Reserve),
    Advance(Advance),
    Restart(Restart),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Reserve {
    pub(super) binding: Binding,
    pub(super) key: String,
    pub(super) now: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Advance {
    pub(super) binding: Binding,
    pub(super) attempt: String,
    pub(super) sequence: i64,
    pub(super) expected: State,
    pub(super) state: State,
    pub(super) reason: Reason,
    pub(super) key: String,
    pub(super) now: i64,
}

impl Advance {
    pub(super) fn validate(&self) -> Result<()> {
        self.binding.validate(&self.key)?;
        require(
            operation_key(&self.attempt) && integer(self.sequence, 1),
            Error::InputInvalid,
        )?;
        require(
            self.expected.allows(self.state) && self.state.accepts(self.reason),
            Error::TransitionInvalid,
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Restart {
    pub(super) now: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    pub(super) employee_id: String,
    pub(super) goal_id: String,
    pub(super) goal_generation: i64,
    pub(super) session_id: String,
    pub(super) session_generation: i64,
    pub(super) transition_sequence: i64,
}

impl Binding {
    pub(super) fn validate(&self, key: &str) -> Result<()> {
        require(self.valid() && operation_key(key), Error::InputInvalid)
    }

    pub(super) fn valid(&self) -> bool {
        Dimension::ALL
            .iter()
            .all(|dimension| canonical_id(self.subject(*dimension)))
            && integer(self.goal_generation, 1)
            && integer(self.session_generation, 1)
            && integer(self.transition_sequence, 0)
    }

    pub(super) fn subject(&self, dimension: Dimension) -> &str {
        match dimension {
            Dimension::Employee => &self.employee_id,
            Dimension::Goal => &self.goal_id,
            Dimension::Session => &self.session_id,
        }
    }

    pub(super) fn overlaps(&self, other: &Self) -> bool {
        Dimension::ALL
            .iter()
            .any(|dimension| self.subject(*dimension) == other.subject(*dimension))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Dimension {
    Employee,
    Goal,
    Session,
}

impl Dimension {
    pub(super) const ALL: [Self; 3] = [Self::Employee, Self::Goal, Self::Session];

    pub(super) fn column(self) -> &'static str {
        match self {
            Self::Employee => "employee",
            Self::Goal => "goal",
            Self::Session => "session",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum State {
    Queued,
    Submitted,
    TurnStarted,
    ProgressObserved,
    Refused,
    Failed,
    Uncertain,
}

impl State {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "QUEUED",
            Self::Submitted => "SUBMITTED",
            Self::TurnStarted => "TURN_STARTED",
            Self::ProgressObserved => "PROGRESS_OBSERVED",
            Self::Refused => "REFUSED",
            Self::Failed => "FAILED",
            Self::Uncertain => "UNCERTAIN",
        }
    }

    pub(super) fn unfinished(self) -> bool {
        matches!(self, Self::Queued | Self::Submitted | Self::TurnStarted)
    }

    pub(super) fn unresolved(self) -> bool {
        self.unfinished() || self == Self::Uncertain
    }

    pub(super) fn allows(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Queued, Self::Submitted | Self::Refused)
                | (Self::Submitted, Self::TurnStarted | Self::Refused)
                | (Self::TurnStarted, Self::ProgressObserved)
        ) || (self.unfinished() && matches!(next, Self::Failed | Self::Uncertain))
    }

    pub(super) fn accepts(self, reason: Reason) -> bool {
        matches!(
            (self, reason),
            (Self::Queued, Reason::Queued)
                | (Self::Submitted, Reason::SubmissionConfirmed)
                | (Self::TurnStarted, Reason::TurnConfirmed)
                | (Self::ProgressObserved, Reason::ProgressConfirmed)
                | (Self::Refused, Reason::PolicyRefused)
                | (Self::Failed, Reason::SubmissionFailed | Reason::TurnFailed)
                | (
                    Self::Uncertain,
                    Reason::SendUncertain | Reason::ProcessRestart
                )
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum Reason {
    Queued,
    SubmissionConfirmed,
    TurnConfirmed,
    ProgressConfirmed,
    PolicyRefused,
    SubmissionFailed,
    TurnFailed,
    SendUncertain,
    ProcessRestart,
}

pub(super) fn canonical_id(value: &str) -> bool {
    (1..=100).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}

pub(super) fn operation_key(value: &str) -> bool {
    (1..=96).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

pub(super) fn receipt_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn integer(value: i64, minimum: i64) -> bool {
    (minimum..=MAX_INTEGER).contains(&value)
}

pub(super) fn usable_clock(now: i64) -> bool {
    (0..=MAX_INTEGER - WINDOW_MS).contains(&now)
}

pub(super) fn canonical<T: Serialize>(value: &T) -> Result<String> {
    let mut json = serde_json::to_value(value)?;
    json.sort_all_objects();
    Ok(serde_json::to_string(&json)?)
}

pub(super) fn digest<T: Serialize>(value: &T) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(canonical(value)?.as_bytes())
    ))
}

pub(super) fn stored<T: serde::de::DeserializeOwned>(raw: &str, maximum: usize) -> Result<T> {
    require(
        raw.len() <= maximum && raw.is_ascii(),
        Error::StoreUnavailable,
    )?;
    Ok(serde_json::from_str(raw)?)
}
