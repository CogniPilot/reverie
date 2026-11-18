use crate::{database::Database, journal, office::Office, refused};
use reverie_contracts::memory::channel::journal::JournalCommit;
use reverie_contracts::memory::channel::{ChannelEvidence, ConfirmedExchange, ExchangeClaim};
use reverie_core::ids::ChatRoomId;
use serde::Deserialize;
use serde_json::{
    Value, json,
    value::{self, RawValue},
};
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
    #[serde(default)]
    journal_enabled: bool,
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
    JournalSource,
    JournalReceipt,
    JournalCommit,
}

#[derive(Deserialize)]
struct Job<'a> {
    config: Settings,
    room: &'a str,
    op: Operation,
    query: Option<String>,
    #[serde(borrow)]
    event: Option<Event<'a>>,
    message_id: Option<String>,
    #[serde(borrow)]
    captured_end: Option<&'a RawValue>,
    turn_id: Option<journal::Reference>,
    expected_hash: Option<String>,
    #[serde(borrow)]
    draft: Option<&'a RawValue>,
    #[serde(borrow)]
    captured: Option<&'a RawValue>,
    #[serde(default, deserialize_with = "journal::previous_id")]
    previous_id: Option<Option<i64>>,
}

pub(crate) fn execute(bytes: &[u8]) -> io::Result<Box<RawValue>> {
    let job: Job = serde_json::from_slice(bytes)?;
    let room = ChatRoomId::parse(job.room).map_err(|_| refused())?;
    job.config.office.validate()?;
    match job.op {
        Operation::Recall => Ok(value::to_raw_value(&recall(
            &job.config,
            &room,
            &job.query.ok_or_else(refused)?,
        )?)?),
        Operation::Record => Ok(value::to_raw_value(&record(
            &job.config,
            &room,
            &job.event.ok_or_else(refused)?,
        )?)?),
        Operation::JournalSource | Operation::JournalReceipt | Operation::JournalCommit => {
            journal_operation(&job, &room)
        }
    }
}

fn journal_operation(job: &Job<'_>, room: &ChatRoomId) -> io::Result<Box<RawValue>> {
    if !job.config.journal_enabled {
        return Err(refused());
    }
    let database = Database::for_room(&job.config.memory_instance, room)?;
    let office = &job.config.office;
    match job.op {
        Operation::JournalSource => journal::source(
            office,
            room,
            job.message_id.as_deref().ok_or_else(refused)?,
            job.captured_end.ok_or_else(refused)?,
        ),
        Operation::JournalReceipt => journal::receipt(
            office,
            room,
            &database,
            job.turn_id.as_ref().ok_or_else(refused)?,
            job.expected_hash.as_deref(),
        ),
        Operation::JournalCommit => {
            let request = JournalCommit::decode(
                job.draft.ok_or_else(refused)?,
                job.captured.ok_or_else(refused)?,
                room,
            )
            .ok_or_else(refused)?;
            journal::commit(
                office,
                room,
                &database,
                &request,
                job.previous_id.ok_or_else(refused)?,
            )
        }
        Operation::Recall | Operation::Record => Err(refused()),
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
