use super::{Code, Counter, Id, InvalidInput, MAX_AGE_MS, MAX_MESSAGES, MAX_ROOMS, Positive};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    pub(super) request: Request,
    pub(super) now_ms: Counter,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    #[serde(rename = "schema_version")]
    schema_version: u64,
    go_id: Id,
    pub(super) transition_id: Id,
    pub(super) idempotency_key: Id,
    pub(super) goal_id: Id,
    pub(super) goal_generation: Positive,
    current_goal_generation: Positive,
    goal_state: GoalState,
    #[serde(deserialize_with = "super::required_nullable")]
    pub(super) decision_id: Option<Id>,
    #[serde(deserialize_with = "super::required_nullable")]
    pub(super) decision_generation: Option<Positive>,
    pub(super) session_id: Id,
    pub(super) session_generation: Positive,
    current_session_generation: Positive,
    pub(super) employee_id: Id,
    rooms: Vec<Id>,
    pub(super) cursor: BTreeMap<Id, Counter>,
    source: Source,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum GoalState {
    Ready,
    Assigned,
    Active,
    Hold,
    Review,
    Done,
    NoGo,
    Cancelled,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    available: bool,
    complete: bool,
    observed_at_ms: Counter,
    messages: Vec<Message>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Message {
    id: Id,
    room_id: Id,
    sequence: Positive,
    at_ms: Counter,
    author_role: AuthorRole,
    mentions_launcher: bool,
    #[serde(deserialize_with = "super::required_nullable")]
    go_id: Option<Id>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum AuthorRole {
    User,
    Coordinator,
    Agent,
    System,
}

impl Request {
    pub(super) fn validate(&self) -> Result<(), InvalidInput> {
        if self.schema_version != 1
            || self.go_id != self.transition_id
            || self.decision_id.is_some() != self.decision_generation.is_some()
            || !(1..=MAX_ROOMS).contains(&self.rooms.len())
        {
            return Err(InvalidInput);
        }
        let rooms: BTreeSet<_> = self.rooms.iter().collect();
        if rooms.len() != self.rooms.len() || !rooms.into_iter().eq(self.cursor.keys()) {
            return Err(InvalidInput);
        }
        self.source.validate()
    }

    pub(super) fn code(&self, now: Counter) -> Code {
        if self.goal_generation != self.current_goal_generation
            || self.session_generation != self.current_session_generation
        {
            Code::GuardGenChanged
        } else if !matches!(self.goal_state, GoalState::Assigned | GoalState::Active) {
            Code::GuardStateNotActive
        } else if !self.source.fresh(now) {
            Code::GuardApiUnavailable
        } else if self
            .source
            .messages
            .iter()
            .any(|message| self.unread(message))
        {
            Code::GuardUnreadInstruction
        } else {
            Code::GuardPass
        }
    }

    fn unread(&self, message: &Message) -> bool {
        self.cursor
            .get(&message.room_id)
            .is_some_and(|cursor| message.sequence.0 > *cursor)
            && (matches!(
                message.author_role,
                AuthorRole::User | AuthorRole::Coordinator
            ) || message.mentions_launcher
                || message.go_id.as_ref() == Some(&self.go_id))
    }

    pub(super) fn newest_seen(&self) -> BTreeMap<Id, Counter> {
        let mut newest = self.cursor.clone();
        for message in &self.source.messages {
            if let Some(seen) = newest.get_mut(&message.room_id) {
                *seen = (*seen).max(message.sequence.0);
            }
        }
        newest
    }
}

impl Source {
    fn validate(&self) -> Result<(), InvalidInput> {
        if self.messages.len() > MAX_MESSAGES {
            return Err(InvalidInput);
        }
        let mut ids = BTreeSet::new();
        let mut positions = BTreeSet::new();
        self.messages
            .iter()
            .all(|message| {
                ids.insert(&message.id) && positions.insert((&message.room_id, message.sequence))
            })
            .then_some(())
            .ok_or(InvalidInput)
    }

    fn fresh(&self, now: Counter) -> bool {
        self.available
            && self.complete
            && now
                .0
                .checked_sub(self.observed_at_ms.0)
                .is_some_and(|age| age <= MAX_AGE_MS)
            && self
                .messages
                .iter()
                .all(|message| message.at_ms <= self.observed_at_ms)
    }
}
