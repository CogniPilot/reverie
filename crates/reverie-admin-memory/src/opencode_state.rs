//! Instance-owned OpenCode state on the existing SQLite memory store.
mod activity;
mod documents;
mod maintenance;
pub(crate) use maintenance::reflection_worker;
mod recall;
mod record;
mod vacation;

use clap::Parser;
use reverie_host::memory_configuration::{MemoryConfiguration, MemoryPath};
use reverie_store::memory::{ContinuityScope, MemoryStore, NativeMemoryRead};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{ffi::OsString, path::PathBuf, process::ExitCode};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Parser)]
#[command(name = "reverie-opencode --bridge")]
struct Arguments {
    #[arg(long)]
    instance: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Request {
    Activity(activity::Request),
    Recall(recall::Request),
    Record(record::Request),
    Maintenance,
    Vacation(vacation::Request),
    Mode,
    Rules,
    #[serde(untagged)]
    Document(documents::Request),
}

pub(super) fn entry(args: impl IntoIterator<Item = OsString>) -> ExitCode {
    let arguments = Arguments::parse_from(args);
    let bound = crate::OPENCODE_CONTEXT_BOUND;
    let reply = crate::bounded_input(bound)
        .map_err(Into::into)
        .and_then(|input| execute(arguments, &input))
        .and_then(|value| Ok(crate::write_reply(&value, bound)?));
    match reply {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", json!({ "error": error.to_string() }));
            ExitCode::FAILURE
        }
    }
}

fn execute(args: Arguments, input: &[u8]) -> Result<Value> {
    match serde_json::from_slice(input)? {
        Request::Rules => Ok(json!(super::opencode_install::rules())),
        Request::Mode => mode(&args),
        Request::Record(request) => request.save(&configuration(&args)?),
        Request::Maintenance => maintenance::run(&configuration(&args)?),
        Request::Recall(request) => request.read(&configuration(&args)?),
        Request::Activity(request) if request.is_research() => {
            Ok(json!({ "ok": true, "research": true }))
        }
        Request::Activity(request) => {
            request.validate()?;
            with_store(&args, |store, _| request.record(store))
        }
        Request::Vacation(request) => with_store(&args, |store, config| {
            let docs = document_store(store, config)?;
            request.apply(store, &docs, &config.native_path(MemoryPath::Data)?)
        }),
        Request::Document(request) => with_store(&args, |store, config| {
            request.apply(&document_store(store, config)?)
        }),
    }
}

fn configuration(args: &Arguments) -> Result<MemoryConfiguration> {
    Ok(MemoryConfiguration::capture_instance(
        args.instance.as_deref(),
    )?)
}

fn document_store<'a>(
    store: &'a MemoryStore,
    config: &MemoryConfiguration,
) -> Result<reverie_store::memory::MemoryDocuments<'a>> {
    let initial = config
        .instance()
        .map(|instance| instance.configuration().initial_model())
        .transpose()?;
    documents::initialized(store, initial)
}

fn mode(args: &Arguments) -> Result<Value> {
    let config = configuration(args)?;
    let record = NativeMemoryRead::read_continuity(
        &config.native_path(MemoryPath::Database)?,
        ContinuityScope::Shared,
    )?;
    match record.lifecycle {
        Some(body) => Ok(serde_json::from_slice(&body.as_json())?),
        None => Ok(json!({"mode":"active"})),
    }
}

fn with_store(
    args: &Arguments,
    operation: impl FnOnce(&MemoryStore, &MemoryConfiguration) -> Result<Value>,
) -> Result<Value> {
    let config = configuration(args)?;
    config.ensure_directories()?;
    let store = MemoryStore::open(config.native_path(MemoryPath::Database)?)?;
    let result = operation(&store, &config);
    let closed = store.close();
    let reply = result?;
    closed?;
    Ok(reply)
}
