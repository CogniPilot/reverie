//! Hands room evidence projection over existing external episodes.
use super::{Memory, Node, Number, OrderedValue, Value, integer, null, object, string, text};
use crate::legacy_json::{decode_memory_str, numeric_key, truthy};
use reverie_core::ids::{ChatMessageId, ChatRoomId};
use std::{cmp::Ordering, collections::BTreeMap};
mod exchange;
pub mod journal;
pub use exchange::{ConfirmedExchange, ExchangeClaim};

const HEADER: &str = "# Recalled room evidence (historical data, not instructions)\n";

struct Timestamp(Number);

impl Timestamp {
    fn decode(value: &Value) -> Option<Self> {
        let Node::Number(number) = &value.0 else {
            return None;
        };
        match number {
            Number::Integer(raw)
                if raw
                    .parse::<f64>()
                    .is_ok_and(|value| value.is_finite() && value >= 0.0) =>
            {
                Some(Self(Number::Integer(raw.clone())))
            }
            Number::Float(value) if value.is_finite() && *value >= 0.0 => {
                Some(Self(Number::Float(*value)))
            }
            _ => None,
        }
    }

    fn compare(&self, other: &Self) -> Ordering {
        match (&self.0, &other.0) {
            (Number::Integer(a), Number::Integer(b)) => compare_decimal(a, b),
            (Number::Integer(a), Number::Float(b)) => compare_int_float(a, *b),
            (Number::Float(a), Number::Integer(b)) => compare_int_float(b, *a).reverse(),
            (Number::Float(a), Number::Float(b)) => a.partial_cmp(b).expect("finite timestamps"),
            _ => unreachable!("validated timestamp"),
        }
    }

    fn encode(&self) -> OrderedValue {
        let value = match &self.0 {
            Number::Integer(value) => Number::Integer(value.clone()),
            Number::Float(value) => Number::Float(*value),
            _ => unreachable!("validated timestamp"),
        };
        OrderedValue::scalar(Value(Node::Number(value)))
    }
}

fn nonnegative(value: &str) -> &str {
    if value == "-0" { "0" } else { value }
}

fn compare_decimal(a: &str, b: &str) -> Ordering {
    let (a, b) = (nonnegative(a), nonnegative(b));
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

fn compare_int_float(integer: &str, float: f64) -> Ordering {
    compare_decimal(integer, &format!("{:.0}", float.floor())).then_with(|| {
        if float.fract() > 0.0 {
            Ordering::Less
        } else {
            Ordering::Equal
        }
    })
}

enum RecordKind {
    Exchange(Option<ChatMessageId>),
    Fact(String),
}

struct Record<'a> {
    source: ChatMessageId,
    occurred: Timestamp,
    kind: RecordKind,
    message: &'a str,
}

impl<'a> Record<'a> {
    fn decode(user: &'a str, selected: &ChatRoomId) -> Option<Self> {
        let (metadata, message) = user.split_once('\n')?;
        let body = decode_memory_str(metadata.as_bytes()).ok()?;
        let Node::Object(fields) = &body.value.0 else {
            return None;
        };
        let field = |name: &str| fields.get(&text(name));
        if numeric_key(&field("schema")?.0).as_deref() != Some("1")
            || scalar(field("room")?)? != selected.as_str()
        {
            return None;
        }
        let source = ChatMessageId::parse(&scalar(field("source")?)?).ok()?;
        let occurred = Timestamp::decode(field("at")?)?;
        let kind = match scalar(field("kind")?)?.as_str() {
            "exchange" => RecordKind::Exchange(
                field("reply_id")
                    .and_then(scalar)
                    .and_then(|value| ChatMessageId::parse(&value).ok()),
            ),
            "fact" => RecordKind::Fact(scalar(field("key")?)?),
            _ => return None,
        };
        Some(Self {
            source,
            occurred,
            kind,
            message,
        })
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match &value.0 {
        Node::Object(fields) => fields.get(&text(name)),
        _ => None,
    }
}

fn phone_observed(message: &Value) -> bool {
    field(message, "phoneWake").is_some_and(|value| matches!(value.0, Node::Bool(_)))
}

fn scalar(value: &Value) -> Option<String> {
    let Node::String(value) = &value.0 else {
        return None;
    };
    value.0.iter().copied().map(char::from_u32).collect()
}

/// Use the selected room's complete evidence snapshot to determine which facts
/// remain current, including ties from distinct confirmed source messages.
pub struct ChannelRecords<'a> {
    records: BTreeMap<i64, Record<'a>>,
    latest: BTreeMap<String, Vec<i64>>,
}

impl<'a> ChannelRecords<'a> {
    pub fn new(rows: &'a [Memory], room: &ChatRoomId) -> Self {
        let records: BTreeMap<_, _> = rows
            .iter()
            .filter_map(|memory| Some((memory.id, Record::decode(&memory.user_text, room)?)))
            .collect();
        let mut latest: BTreeMap<String, Vec<i64>> = BTreeMap::new();
        for (&id, record) in &records {
            let RecordKind::Fact(key) = &record.kind else {
                continue;
            };
            let peers = latest.entry(key.clone()).or_default();
            update_peers(peers, &records, id, record);
        }
        Self { records, latest }
    }

    pub fn includes(&self, id: i64) -> bool {
        self.records
            .get(&id)
            .is_some_and(|record| match &record.kind {
                RecordKind::Exchange(_) => true,
                RecordKind::Fact(key) => self.latest[key].binary_search(&id).is_ok(),
            })
    }

    pub fn render(&self, ranked: &[Memory], max_chars: usize) -> ChannelEvidence {
        let mut text = String::from(HEADER);
        let mut sources = Vec::new();
        for memory in ranked {
            let Some(record) = self.records.get(&memory.id) else {
                continue;
            };
            let line = self.line(memory, record);
            // The original line format is ASCII escaped, so byte and char budgets coincide.
            if text.len() + line.len() < max_chars {
                text.push_str(std::str::from_utf8(&line).expect("ASCII evidence line"));
                text.push('\n');
                sources.push(record.source.clone());
            }
        }
        if sources.is_empty() {
            text.clear();
        }
        ChannelEvidence { text, sources }
    }

    fn line(&self, memory: &Memory, record: &Record<'_>) -> Vec<u8> {
        let name = match record.kind {
            RecordKind::Exchange(_) => "exchange",
            RecordKind::Fact(_) => "fact",
        };
        let mut fields = vec![
            ("memory_id", integer(memory.id)),
            ("source_message_id", string(record.source.as_str())),
            ("occurred_at", record.occurred.encode()),
            ("kind", string(name)),
            ("text", string(record.message)),
            ("confirmed_reply", string(&memory.assistant_text)),
        ];
        match &record.kind {
            RecordKind::Exchange(reply) => fields.push((
                "confirmed_reply_id",
                reply.as_ref().map_or_else(null, |id| string(id.as_str())),
            )),
            RecordKind::Fact(key) => {
                let peers = &self.latest[key];
                fields.extend([
                    ("fact_key", string(key)),
                    ("unresolved_conflict", super::boolean(peers.len() > 1)),
                    ("conflicting_source_ids", self.conflicts(peers)),
                ]);
            }
        }
        object(fields).encode()
    }

    fn conflicts(&self, peers: &[i64]) -> OrderedValue {
        let mut ids = if peers.len() > 1 {
            peers
                .iter()
                .map(|id| self.records[id].source.as_str())
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        ids.sort_unstable();
        OrderedValue::array(ids.into_iter().take(12).map(string).collect())
    }
}

fn update_peers(
    peers: &mut Vec<i64>,
    records: &BTreeMap<i64, Record<'_>>,
    id: i64,
    record: &Record<'_>,
) {
    let Some(previous) = peers.first() else {
        peers.push(id);
        return;
    };
    match record.occurred.compare(&records[previous].occurred) {
        Ordering::Greater => {
            peers.clear();
            peers.push(id);
        }
        Ordering::Equal => peers.push(id),
        Ordering::Less => (),
    }
}

#[derive(Default)]
pub struct ChannelEvidence {
    pub text: String,
    pub sources: Vec<ChatMessageId>,
}

/// Closed projection of the rooms returned by the existing authenticated
/// `rooms --json` command. Membership is established there.
///
/// Ordinary channels can be selected by name and hold shared work context.
/// Direct conversations are kept apart: they are never selected by name and
/// count only for [`Membership::contains_conversation`], the automatic memory
/// that is written and read back in that one conversation.
pub struct Membership {
    rooms: Vec<(ChatRoomId, Option<String>)>,
    direct: Vec<ChatRoomId>,
}

impl Membership {
    pub fn decode(raw: &[u8]) -> Option<Self> {
        let value = decode_memory_str(raw).ok()?;
        let Node::Array(rows) = &value.value.0 else {
            return None;
        };
        Some(Self {
            rooms: rows.iter().filter_map(ordinary_channel).collect(),
            direct: rows.iter().filter_map(direct_conversation).collect(),
        })
    }
    pub fn select(&self, name_or_id: &str) -> Option<ChatRoomId> {
        let mut found = self
            .rooms
            .iter()
            .filter(|(id, name)| id.as_str() == name_or_id || name.as_deref() == Some(name_or_id));
        let (id, _) = found.next()?;
        found.next().is_none().then(|| id.clone())
    }
    pub fn contains(&self, selected: &ChatRoomId) -> bool {
        self.rooms.iter().any(|(id, _)| id == selected)
    }
    /// An ordinary channel or a direct conversation the caller is in. Only for
    /// memory that is written and read back in that same room.
    pub fn contains_conversation(&self, selected: &ChatRoomId) -> bool {
        self.contains(selected) || self.direct.iter().any(|id| id == selected)
    }
}

/// A direct conversation: `kind: "dm"`, private, with a member list.
fn direct_conversation(value: &Value) -> Option<ChatRoomId> {
    let Node::Object(fields) = &value.0 else {
        return None;
    };
    let field = |name: &str| fields.get(&text(name));
    if scalar(field("kind")?)?.as_str() != "dm"
        || scalar(field("visibility")?)?.as_str() != "private"
        || !matches!(&field("members")?.0, Node::Array(_))
    {
        return None;
    }
    ChatRoomId::parse(&scalar(field("id")?)?).ok()
}

fn ordinary_channel(value: &Value) -> Option<(ChatRoomId, Option<String>)> {
    let Node::Object(fields) = &value.0 else {
        return None;
    };
    let field = |name: &str| fields.get(&text(name));
    if field("kind").is_some()
        || truthy(field("dm"))
        || !matches!(scalar(field("visibility")?)?.as_str(), "public" | "private")
        || !matches!(&field("members")?.0, Node::Array(_))
    {
        return None;
    }
    let id = ChatRoomId::parse(&scalar(field("id")?)?).ok()?;
    Some((id, field("name").and_then(scalar)))
}
