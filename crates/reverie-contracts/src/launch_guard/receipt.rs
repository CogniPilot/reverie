use super::{
    Code, Counter, Id, InvalidReceipt, MAX_ROOMS, Positive, canonical, decode, request, sha256,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fields {
    #[serde(rename = "schema_version")]
    schema_version: u64,
    receipt_type: ReceiptType,
    goal_id: Id,
    goal_generation: Positive,
    #[serde(deserialize_with = "super::required_nullable")]
    decision_id: Option<Id>,
    #[serde(deserialize_with = "super::required_nullable")]
    decision_generation: Option<Positive>,
    session_id: Id,
    session_generation: Positive,
    employee_id: Id,
    transition_id: Id,
    idempotency_key: Id,
    created_at_ms: Counter,
    level: Level,
    code: Code,
    data: Data,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum ReceiptType {
    LaunchGuard,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Level {
    Synthetic,
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Outcome {
    Pass,
    Refuse,
}

impl From<Code> for Outcome {
    fn from(code: Code) -> Self {
        if code == Code::GuardPass {
            Self::Pass
        } else {
            Self::Refuse
        }
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Data {
    go_id: Id,
    rooms: Vec<Id>,
    #[serde(rename = "cursor_checked")]
    cursor_checked: BTreeMap<Id, Counter>,
    #[serde(rename = "newest_seen")]
    newest_seen: BTreeMap<Id, Counter>,
    result: Outcome,
    snapshot_sha256: String,
}

impl Data {
    fn consistent(&self) -> bool {
        (1..=MAX_ROOMS).contains(&self.rooms.len())
            && self.rooms.windows(2).all(|rooms| rooms[0] < rooms[1])
            && self.rooms.iter().eq(self.cursor_checked.keys())
            && self.rooms.iter().eq(self.newest_seen.keys())
            && self
                .newest_seen
                .values()
                .zip(self.cursor_checked.values())
                .all(|(seen, cursor)| seen >= cursor)
            && hex_digest(&self.snapshot_sha256)
    }
}

fn hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Synthetic v1 receipt with a checked printable envelope and mutation digest.
#[derive(Clone)]
pub struct Receipt {
    fields: Fields,
    receipt_id: String,
}

impl Receipt {
    pub(super) fn new(request: &request::Request, now: Counter) -> Self {
        let code = request.code(now);
        let fields = Fields {
            schema_version: 1,
            receipt_type: ReceiptType::LaunchGuard,
            goal_id: request.goal_id.clone(),
            goal_generation: request.goal_generation,
            decision_id: request.decision_id.clone(),
            decision_generation: request.decision_generation,
            session_id: request.session_id.clone(),
            session_generation: request.session_generation,
            employee_id: request.employee_id.clone(),
            transition_id: request.transition_id.clone(),
            idempotency_key: request.idempotency_key.clone(),
            created_at_ms: now,
            level: Level::Synthetic,
            code,
            data: Data {
                go_id: request.transition_id.clone(),
                rooms: request.cursor.keys().cloned().collect(),
                cursor_checked: request.cursor.clone(),
                newest_seen: request.newest_seen(),
                result: Outcome::from(code),
                snapshot_sha256: sha256(request),
            },
        };
        let receipt_id = sha256(&fields);
        Self { fields, receipt_id }
    }

    pub fn decode(raw: &[u8]) -> Result<Self, InvalidReceipt> {
        let mut value: Value = decode(raw).map_err(|_| InvalidReceipt)?;
        let id = value
            .as_object_mut()
            .and_then(|fields| fields.remove("receiptId"));
        let Some(Value::String(receipt_id)) = id else {
            return Err(InvalidReceipt);
        };
        let fields: Fields = serde_json::from_value(value).map_err(|_| InvalidReceipt)?;
        let valid = fields.schema_version == 1
            && fields.decision_id.is_some() == fields.decision_generation.is_some()
            && fields.data.go_id == fields.transition_id
            && fields.data.result == Outcome::from(fields.code)
            && fields.data.consistent()
            && hex_digest(&receipt_id)
            && sha256(&fields) == receipt_id;
        valid
            .then_some(Self { fields, receipt_id })
            .ok_or(InvalidReceipt)
    }

    pub fn passed(&self) -> bool {
        self.fields.code == Code::GuardPass
    }

    pub fn bytes(&self) -> Vec<u8> {
        let mut value = serde_json::to_value(&self.fields).expect("synthetic receipt fields");
        value
            .as_object_mut()
            .expect("synthetic receipt envelope")
            .insert(
                "receiptId".to_owned(),
                Value::String(self.receipt_id.clone()),
            );
        canonical(&value)
    }
}
