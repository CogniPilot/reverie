//! Compatibility boundary for callers sharing the native project store.
use reverie_application::project_memory::ProjectMemory;
use reverie_contracts::memory::MemoryView;
use reverie_core::{memory::EmbeddingText, posix_text};
use serde::Deserialize;
use serde_json::{json, value::RawValue};
use std::{ffi::OsString, io, os::unix::ffi::OsStringExt, path::PathBuf};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
struct Request {
    root: Vec<u32>,
    project: String,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Operation {
    Lookup { query: Vec<u32> },
    Remember { text: Vec<u32>, source: Vec<u32> },
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let bound = crate::OPENCODE_CONTEXT_BOUND;
    let frame = crate::worker_input(parent, bound)?;
    let result = serde_json::from_slice::<Request>(&frame)
        .map_err(Into::into)
        .and_then(execute);
    match result {
        Ok(value) => crate::write_reply(&json!({ "value": value }), bound),
        Err(error) => crate::write_reply(&json!({ "error": error.to_string() }), bound),
    }
}

fn execute(request: Request) -> Result<Box<RawValue>> {
    let root = PathBuf::from(OsString::from_vec(
        posix_text::encode(&request.root).map_err(io::Error::other)?,
    ));
    let project = ProjectMemory::open(root, &request.project)?;
    let outcome = match request.operation {
        Operation::Lookup { query } => lookup(&project, &query),
        Operation::Remember { text, source } => remember(&project, &text, &source),
    };
    let closed = project.close();
    let reply = outcome?;
    closed?;
    Ok(reply)
}

fn lookup(project: &ProjectMemory, query: &[u32]) -> Result<Box<RawValue>> {
    let records = project.lookup_text(EmbeddingText::from_codepoints(query)?)?;
    let replies: Vec<_> = records.iter().map(memory_json).collect::<Result<_>>()?;
    Ok(serde_json::value::to_raw_value(&replies)?)
}

fn remember(project: &ProjectMemory, text: &[u32], source: &[u32]) -> Result<Box<RawValue>> {
    let view = project.remember_text(
        EmbeddingText::from_codepoints(text)?,
        EmbeddingText::from_codepoints(source)?,
    )?;
    memory_json(&view)
}

fn memory_json(view: &MemoryView) -> Result<Box<RawValue>> {
    Ok(serde_json::from_slice(view.as_json())?)
}
