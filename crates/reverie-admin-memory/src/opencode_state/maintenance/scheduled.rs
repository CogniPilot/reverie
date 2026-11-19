//! Dream persistence for the cycle's externally metered model request.
use super::{Result, dreaming::Attempt, maintenance_lock, now, state, try_lock};
use crate::worker_channel::WorkerChannel;
use reverie_host::memory_configuration::{MemoryConfiguration, MemoryPath};
use reverie_store::memory::MemoryStore;
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    instance: PathBuf,
    database: PathBuf,
    creative: String,
    vacation: bool,
}

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Event<'a> {
    Busy,
    VacationLimit,
    Prompt { prompt: &'a super::dreaming::Prompt },
    Finished { memory_id: Option<i64> },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    text: Option<String>,
}

pub(crate) fn run(parent: i32) -> io::Result<()> {
    crate::bind_worker(parent)?;
    let mut channel = WorkerChannel::open()?;
    let request: Request = channel
        .read(Some(deadline(10)))?
        .ok_or_else(crate::refused)?;
    let event = execute(&mut channel, &request).map_err(|_| crate::refused())?;
    channel.write(&event, Some(deadline(5)))
}

fn execute(channel: &mut WorkerChannel, request: &Request) -> Result<Event<'static>> {
    if !request.instance.is_absolute() || request.creative.chars().count() > 8000 {
        return Err(crate::refused().into());
    }
    let config = MemoryConfiguration::capture_instance(Some(&request.instance))?;
    let database = config.native_path(MemoryPath::Database)?;
    if database != request.database {
        return Err(crate::refused().into());
    }
    config.ensure_directories()?;
    let Some(_lock) = try_lock(&maintenance_lock(&config)?)? else {
        return Ok(Event::Busy);
    };
    // The cycle's existing writer uses the default hashed embedding for this store.
    let store = MemoryStore::open(database)?;
    let result = attempt(channel, request, &config, &store);
    let closed = store.close();
    let event = result?;
    closed?;
    Ok(event)
}

fn attempt(
    channel: &mut WorkerChannel,
    request: &Request,
    config: &MemoryConfiguration,
    store: &MemoryStore,
) -> Result<Event<'static>> {
    let timestamp = now()?;
    if request.vacation {
        let key = "vacation_last_dream_attempt";
        if timestamp - state(store, key, 0.0)? < 86400.0 {
            return Ok(Event::VacationLimit);
        }
        store.set_state(key, &timestamp.to_string())?;
    }
    let Some(attempt) = Attempt::prepare(config, store, timestamp, &request.creative)? else {
        return Ok(Event::Finished { memory_id: None });
    };
    channel.write(
        &Event::Prompt {
            prompt: &attempt.prompt,
        },
        Some(deadline(10)),
    )?;
    // The scheduler's model call is capped at 240 seconds, with time left for settlement.
    let Some(reply) = channel.read::<Reply>(Some(deadline(255)))? else {
        return Err(crate::refused().into());
    };
    let memory_id = attempt
        .finish(store, reply.text, 1.0)?
        .map(|memory| memory.id);
    Ok(Event::Finished { memory_id })
}

fn deadline(seconds: u64) -> Instant {
    Instant::now() + Duration::from_secs(seconds)
}
