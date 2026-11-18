//! Verify a confirmed exchange using the authenticated Office room readback.
use super::{Timestamp, scalar};
use crate::legacy_json::{Node, Value, decode_memory_str, truthy};
use crate::memory::{integer, object, string, text};
use reverie_core::ids::{ChatMessageId, ChatRoomId};

pub struct ExchangeClaim<'a> {
    pub source: &'a str,
    pub at: &'a str,
    pub text: &'a str,
    pub reply_id: &'a str,
    pub reply: &'a str,
}

pub struct ConfirmedExchange<'a> {
    source: ChatMessageId,
    at: Timestamp,
    text: &'a str,
    reply_id: ChatMessageId,
    reply: &'a str,
    room: &'a ChatRoomId,
}

impl<'a> ConfirmedExchange<'a> {
    pub fn verify(
        claim: ExchangeClaim<'a>,
        room: &'a ChatRoomId,
        session: &str,
        source_chars: usize,
        readback: &[u8],
    ) -> Option<Self> {
        let exchange = Self {
            source: ChatMessageId::parse(claim.source).ok()?,
            at: Timestamp::decode(&decode_memory_str(claim.at.as_bytes()).ok()?.value)?,
            text: bounded_text(claim.text)?,
            reply_id: ChatMessageId::parse(claim.reply_id).ok()?,
            reply: bounded_text(claim.reply)?,
            room,
        };
        let envelope = decode_memory_str(readback).ok()?;
        let messages = messages(&envelope.value)?;
        let source = find(&messages, &exchange.source, room)?;
        let reply = find(&messages, &exchange.reply_id, room)?;
        exchange
            .matches(source, reply, session, source_chars)
            .then_some(exchange)
    }

    fn matches(&self, source: &Value, reply: &Value, session: &str, source_chars: usize) -> bool {
        field(source, "at")
            .and_then(Timestamp::decode)
            .is_some_and(|at| at.compare(&self.at).is_eq())
            && matches_prefix(source, self.text, source_chars)
            && field(reply, "from")
                .and_then(|from| field(from, "sessionId"))
                .and_then(scalar)
                .as_deref()
                == Some(session)
            && field(reply, "text").and_then(scalar).as_deref() == Some(self.reply)
    }

    pub fn external_source(&self) -> String {
        format!("room:{}:message:{}:exchange:", self.room, self.source)
    }

    pub fn user_text(&self) -> String {
        let metadata = object(vec![
            ("at", self.at.encode()),
            ("kind", string("exchange")),
            ("reply_id", string(self.reply_id.as_str())),
            ("room", string(self.room.as_str())),
            ("schema", integer(1)),
            ("source", string(self.source.as_str())),
        ])
        .encode();
        format!("{}\n{}", String::from_utf8_lossy(&metadata), self.text)
    }

    pub fn reply(&self) -> &str {
        self.reply
    }
}

fn bounded_text(value: &str) -> Option<&str> {
    (!value.trim().is_empty() && value.chars().count() <= 16_000).then_some(value)
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match &value.0 {
        Node::Object(fields) => fields.get(&text(name)),
        _ => None,
    }
}

fn messages(value: &Value) -> Option<Vec<&Value>> {
    let Node::Array(rows) = &field(value, "messages")?.0 else {
        return None;
    };
    rows.iter()
        .filter(|row| truthy(field(row, "id")))
        .map(|row| matches!(field(row, "phoneWake")?.0, Node::Bool(_)).then_some(row))
        .collect()
}

fn find<'a>(rows: &[&'a Value], id: &ChatMessageId, room: &ChatRoomId) -> Option<&'a Value> {
    let row = rows
        .iter()
        .copied()
        .find(|row| field(row, "id").and_then(scalar).as_deref() == Some(id.as_str()))?;
    (field(row, "roomId").and_then(scalar).as_deref() == Some(room.as_str())).then_some(row)
}

fn matches_prefix(source: &Value, expected: &str, max_chars: usize) -> bool {
    field(source, "text")
        .and_then(scalar)
        .is_some_and(|actual| actual.chars().take(max_chars).eq(expected.chars()))
}
