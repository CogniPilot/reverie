//! One optional OpenCode maintenance pass in the current runtime namespace.
mod dreaming;
mod gpu;
mod manual;
mod model;
mod reflection;
mod scheduled;
pub(crate) use gpu::try_lock;
pub(crate) use manual::{dream_once, rate_once, reflect_once, router_check};
pub(crate) use reflection::insight::run as reflection_worker;
pub(crate) use scheduled::run as cycle_dream_worker;

use super::{Result, documents};
use reverie_application::memory_startup::StartedMemory;
use reverie_core::{
    PythonText,
    memory::{RATING_SUFFIX, RATING_SYSTEM, importance_rating},
    memory_configuration::{FloatSetting, IntegerSetting},
};
use reverie_host::memory_configuration::{MemoryConfiguration, MemoryPath};
use reverie_store::memory::MemoryStore;
use serde_json::{Value, json};
use std::{
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) fn run(config: &MemoryConfiguration) -> Result<Value> {
    admitted(config, || {
        let memory = StartedMemory::initialize(config, &[])?;
        let result = pass(config, memory.store());
        let closed = memory.close();
        let reply = result?;
        closed?;
        Ok(reply)
    })
}

pub(crate) fn run_started(config: &MemoryConfiguration, store: &MemoryStore) -> Result<Value> {
    admitted(config, || pass(config, store))
}

pub(crate) fn due(
    config: &MemoryConfiguration,
    store: &MemoryStore,
    now: f64,
) -> Result<(bool, bool)> {
    let activity = state(store, "reverie_last_activity", now)?;
    Ok((
        reflection::Batch::due(config, store, now)?.is_some(),
        dreaming::due(config, store, now, activity)?,
    ))
}

fn admitted(config: &MemoryConfiguration, run: impl FnOnce() -> Result<Value>) -> Result<Value> {
    config.ensure_directories()?;
    let lock_path = maintenance_lock(config)?;
    let Some(_lock) = try_lock(&lock_path)? else {
        return Ok(json!({"skipped":"another maintenance pass is running"}));
    };
    if gpu::busy(config) {
        return Ok(busy());
    }
    run()
}

fn maintenance_lock(config: &MemoryConfiguration) -> std::io::Result<std::path::PathBuf> {
    Ok(config
        .native_path(MemoryPath::Data)?
        .join("maintenance.lock"))
}

fn pass(config: &MemoryConfiguration, store: &MemoryStore) -> Result<Value> {
    let docs = store.documents(None);
    let lifecycle = docs.read(
        &documents::name("lifecycle"),
        Some(documents::decode(&json!({"mode":"active"}))?),
    )?;
    let now = now()?;
    let activity = state(store, "reverie_last_activity", now)?;
    let mode = documents::body(&lifecycle)?["mode"]
        .as_str()
        .ok_or("invalid lifecycle mode")?
        .to_owned();
    if mode == "vacation" {
        return vacation(config, store, now, activity);
    }
    let Some(rated) = rate(config, store, integer(config, IntegerSetting::RatingBatch)?)? else {
        return Ok(busy());
    };
    if rated != 0 {
        return Ok(json!({"action":"rated","count":rated}));
    }
    if let Some(batch) = reflection::Batch::due(config, store, now)? {
        let Some(guard) = gpu::Gpu::acquire(config, "chat")? else {
            return Ok(busy());
        };
        let reflected = batch.run(config, store, now);
        guard.finish()?;
        let reflected = reflected?;
        if !reflected.is_empty() {
            return Ok(json!({"action":"reflected","count":reflected.len()}));
        }
    }
    let dreamed = dreaming::due(config, store, now, activity)?
        && dreaming::run(config, store, &docs, now, false)?.is_some();
    Ok(json!({"action":if dreamed {"dreamed"} else {"idle"}, "count":usize::from(dreamed)}))
}

fn vacation(
    config: &MemoryConfiguration,
    store: &MemoryStore,
    now: f64,
    activity: f64,
) -> Result<Value> {
    let previous = state(store, "vacation_last_dream_attempt", 0.0)?;
    if now - previous < 86400.0 || !dreaming::due(config, store, now, activity)? {
        return Ok(json!({"skipped":"vacation dream budget or sleep window"}));
    }
    if !gpu::vacation_available(config) {
        return Ok(json!({"skipped":"vacation yields to the active admin or GPU"}));
    }
    store.set_state("vacation_last_dream_attempt", &now.to_string())?;
    let dreamed = dreaming::run(config, store, &store.documents(None), now, true)?.is_some();
    Ok(json!({"action":if dreamed {"dreamed"} else {"vacation dream skipped"}}))
}

fn rate(config: &MemoryConfiguration, store: &MemoryStore, limit: i64) -> Result<Option<usize>> {
    let mut count = 0;
    for row in store.pending_importance(limit)? {
        if row.is_idle()? {
            store.set_importance(
                row.id,
                config.settings().float(FloatSetting::JokeImportance),
                "fixed",
            )?;
            continue;
        }
        let Some(guard) = gpu::Gpu::acquire(config, "chat")? else {
            return Ok((count != 0).then_some(count));
        };
        let reply = model::complete(
            config,
            RATING_SYSTEM,
            &format!("{}{RATING_SUFFIX}", row.text),
            8,
            0.0,
            40,
            false,
        );
        guard.finish()?;
        let fallback = config.settings().float(FloatSetting::DefaultImportance);
        let score = reply
            .map(|text| PythonText::from_scalar_text(&text))
            .and_then(|text| importance_rating(text.codepoints()))
            .map_or(fallback, f64::from);
        store.set_importance(row.id, score, "model")?;
        count += 1;
    }
    Ok(Some(count))
}

fn busy() -> Value {
    json!({"skipped":"GPU busy or maintenance held"})
}

fn now() -> Result<f64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64())
}

fn integer(config: &MemoryConfiguration, key: IntegerSetting) -> Result<i64> {
    config
        .settings()
        .integer(key)
        .to_i64()
        .ok_or("maintenance setting out of range".into())
}

fn state<T: FromStr>(store: &MemoryStore, key: &str, fallback: T) -> Result<T> {
    match store
        .get_state(key, None)?
        .filter(|value| !value.is_empty())
    {
        Some(value) => value
            .trim()
            .parse()
            .map_err(|_| format!("invalid maintenance state {key}").into()),
        None => Ok(fallback),
    }
}
