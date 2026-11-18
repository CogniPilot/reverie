use crate::{database::Database, office::Office, refused};
use reverie_contracts::memory::channel::{ChannelEvidence, ConfirmedExchange, ExchangeClaim};
use reverie_core::ids::ChatRoomId;
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use std::{io, path::PathBuf};

#[derive(Deserialize)]
struct Settings {
    #[serde(flatten)]
    office: Office,
    memory_instance: PathBuf,
    recall_cap_chars: usize,
    history_n: i64,
    message_cap_chars: usize,
    self_session_id: String,
}

#[derive(Deserialize)]
struct Event<'a> {
    source: &'a str,
    #[serde(borrow)]
    at: &'a RawValue,
    text: String,
    reply_id: &'a str,
    reply: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    Recall,
    Record,
}

#[derive(Deserialize)]
struct Job<'a> {
    config: Settings,
    room: &'a str,
    op: Operation,
    query: Option<String>,
    #[serde(borrow)]
    event: Option<Event<'a>>,
}

pub(crate) fn execute(bytes: &[u8]) -> io::Result<Value> {
    let job: Job = serde_json::from_slice(bytes)?;
    let room = ChatRoomId::parse(job.room).map_err(|_| refused())?;
    job.config.office.validate()?;
    match job.op {
        Operation::Recall => recall(&job.config, &room, &job.query.ok_or_else(refused)?),
        Operation::Record => record(&job.config, &room, &job.event.ok_or_else(refused)?),
    }
}

fn recall(settings: &Settings, room: &ChatRoomId, query: &str) -> io::Result<Value> {
    let max_chars = settings.recall_cap_chars;
    if query.chars().count() > 4000 || max_chars > crate::MAX_CHARS {
        return Err(refused());
    }
    let database = Database::for_room(&settings.memory_instance, room)?;
    settings.office.require_membership(room)?;
    let evidence = if query.trim().is_empty() || max_chars == 0 {
        ChannelEvidence::default()
    } else {
        settings.office.require_membership(room)?;
        let store = database.writable()?;
        let result = store.recall_channel(room, query, max_chars);
        store.close().map_err(|_| refused())?;
        let evidence = result.map_err(|_| refused())?;
        settings.office.require_membership(room)?;
        evidence
    };
    let sources: Vec<_> = evidence.sources.iter().map(|id| id.as_str()).collect();
    Ok(json!({"text": evidence.text, "sources": sources}))
}

fn record(settings: &Settings, room: &ChatRoomId, event: &Event<'_>) -> io::Result<Value> {
    let database = Database::for_room(&settings.memory_instance, room)?;
    let history = settings.office.history(room, settings.history_n)?;
    let claim = ExchangeClaim {
        source: event.source,
        at: event.at.get(),
        text: &event.text,
        reply_id: event.reply_id,
        reply: &event.reply,
    };
    let exchange = ConfirmedExchange::verify(
        claim,
        room,
        &settings.self_session_id,
        settings.message_cap_chars,
        &history,
    )
    .ok_or_else(refused)?;
    settings.office.require_membership(room)?;
    let store = database.writable()?;
    let result = settings.office.require_membership(room).and_then(|()| {
        store
            .add_external_episode(
                &exchange.external_source(),
                &exchange.user_text(),
                exchange.reply(),
                "room",
            )
            .map_err(|_| refused())
    });
    store.close().map_err(|_| refused())?;
    Ok(json!({"id": result?.id}))
}
