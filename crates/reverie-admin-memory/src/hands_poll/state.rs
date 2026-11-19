use crate::hands_addressing::{Scope, WakePolicy};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use std::{
    collections::{BTreeMap, HashSet},
    io,
};

const SEEN_LIMIT: usize = 500;
const RETRIES: u64 = 1;

#[derive(Deserialize, Serialize)]
pub(super) struct Room {
    #[serde(default)]
    seen: Vec<String>,
    #[serde(default)]
    claims: BTreeMap<String, Claim>,
    since: Option<Number>,
    last_id: Option<String>,
    #[serde(flatten)]
    other: Map<String, Value>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Claim {
    msg_at: Number,
    tries: u64,
    #[serde(flatten)]
    other: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Change {
    Claim { id: String, msg_at: Number },
    Skip { id: String },
    Complete { id: String },
    Advance { latest: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Disposition {
    Settled,
    Abandoned,
}

impl Disposition {
    pub(super) fn as_str(&self) -> &'static str {
        match self {
            Self::Settled => "settled",
            Self::Abandoned => "abandoned",
        }
    }
}

impl Claim {
    pub(super) fn disposition(&self, session: &str, history: &[Value]) -> Option<Disposition> {
        let at = self.msg_at.as_f64().unwrap_or_default();
        if history
            .iter()
            .any(|row| row["from"]["sessionId"].as_str() == Some(session) && when(row) > at)
        {
            Some(Disposition::Settled)
        } else {
            (self.tries > RETRIES).then_some(Disposition::Abandoned)
        }
    }
}

impl Room {
    pub(super) fn claim_ids(&self) -> Vec<String> {
        self.claims.keys().cloned().collect()
    }

    pub(super) fn claim(&self, id: &str) -> Option<&Claim> {
        self.claims.get(id)
    }

    pub(super) fn initialize(&mut self, history: &[Value], latest: Option<String>) -> bool {
        if self.since.is_some() {
            return false;
        }
        let last = history
            .iter()
            .max_by(|left, right| when(left).total_cmp(&when(right)));
        self.since = Some(
            last.filter(|row| when(row) > 0.0)
                .and_then(|row| row["at"].as_number().cloned())
                .unwrap_or_else(|| Number::from(0)),
        );
        self.seen = history
            .iter()
            .rev()
            .filter_map(id)
            .take(SEEN_LIMIT)
            .map(str::to_owned)
            .collect();
        self.seen.reverse();
        self.last_id = latest;
        true
    }

    pub(super) fn pending(&self, scope: &Scope, history: &[Value]) -> Vec<(usize, bool)> {
        let since = self
            .since
            .as_ref()
            .and_then(Number::as_f64)
            .unwrap_or_default();
        let seen: HashSet<_> = self.seen.iter().map(String::as_str).collect();
        let mut entries: Vec<_> = history
            .iter()
            .enumerate()
            .filter(|(_, row)| id(row).is_some_and(|id| when(row) >= since && !seen.contains(id)))
            .collect();
        entries.sort_by(|(_, left), (_, right)| when(left).total_cmp(&when(right)));
        let policy = WakePolicy::new(scope, history);
        entries
            .into_iter()
            .map(|(index, row)| (index, policy.accepts(row)))
            .collect()
    }

    pub(super) fn apply(&mut self, event: Change) -> io::Result<()> {
        match event {
            Change::Claim { id, msg_at } => {
                let tries = self
                    .claims
                    .get(&id)
                    .map_or(0, |claim| claim.tries)
                    .checked_add(1)
                    .ok_or_else(crate::refused)?;
                self.claims.insert(
                    id,
                    Claim {
                        msg_at,
                        tries,
                        other: Map::new(),
                    },
                );
            }
            Change::Complete { id } => {
                self.claims.remove(&id);
                self.remember(id);
            }
            Change::Skip { id } => self.remember(id),
            Change::Advance { latest } => self.last_id = latest,
        }
        Ok(())
    }

    fn remember(&mut self, id: String) {
        self.seen.push(id);
        self.seen
            .drain(..self.seen.len().saturating_sub(SEEN_LIMIT));
    }
}

fn when(row: &Value) -> f64 {
    row["at"].as_f64().unwrap_or_default()
}

fn id(row: &Value) -> Option<&str> {
    row["id"].as_str()
}
