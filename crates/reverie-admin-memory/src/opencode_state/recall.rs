//! Keep Office journal results separate from older private or project history.
use super::Result;
use crate::capture::{self, Limits, Signals};
use reverie_application::{memory_startup::StartedMemory, project_memory::ProjectMemory};
use reverie_contracts::{memory::MemoryView, memory_cli::MemoryReply};
use reverie_core::memory::trim_text;
use reverie_host::memory_configuration::{MemoryConfiguration, MemoryPath};
use reverie_store::memory::RetrievalOptions;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env, io,
    process::Command,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
pub(super) struct Request {
    query: Option<String>,
    project: Option<String>,
    channel: Option<String>,
}

impl Request {
    pub(super) fn read(self, config: &MemoryConfiguration) -> Result<Value> {
        let project = self.project.as_deref().filter(|name| !name.is_empty());
        if project.is_none() && self.channel.as_deref() == Some("work") {
            return Err(
                "private recall is unavailable in a shared work channel; select a project".into(),
            );
        }
        let query = self.query.as_deref().unwrap_or_default();
        let office = env::var_os("REVERIE_SESSION_ID").is_some_and(|session| !session.is_empty());
        if office && trim_text(query).is_empty() {
            return Err("recall needs a query".into());
        }
        let memories = match project {
            Some(project) => project_history(config, project, query)?,
            None => private_history(config, query)?,
        };
        let legacy = serde_json::from_slice(MemoryReply::recalled(&memories).as_json())?;
        if !office {
            return Ok(legacy);
        }
        let frame = json!({"action":"recall", "query":query, "private":project.is_none(),
                           "project":project, "channel":self.channel});
        match office_history(&frame)? {
            Ok(Value::Object(mut result)) => {
                result.insert("legacy".into(), legacy);
                Ok(Value::Object(result))
            }
            Ok(_) => Ok(legacy),
            Err(reason) => Ok(json!({"legacy":legacy, "journal":[],
                "note": format!("journal lookup failed ({reason}); these are only older, read-only results from the old store")})),
        }
    }
}

fn project_history(
    config: &MemoryConfiguration,
    name: &str,
    query: &str,
) -> Result<Vec<MemoryView>> {
    config.ensure_directories()?;
    let memory = ProjectMemory::open(config.native_path(MemoryPath::Data)?.join("projects"), name)?;
    let result = memory.lookup(query);
    let closed = memory.close();
    let history = result?;
    closed?;
    Ok(history)
}

fn private_history(config: &MemoryConfiguration, query: &str) -> Result<Vec<MemoryView>> {
    // Preserve legacy startup, embedding selection and access timestamps.
    let memory = StartedMemory::initialize(config, &[])?;
    let result = memory.store().retrieve(
        query,
        RetrievalOptions {
            k: 8,
            ..RetrievalOptions::default()
        },
    );
    let closed = memory.close();
    let records = result?;
    closed?;
    Ok(records.iter().map(|record| record.as_dict()).collect())
}

fn office_history(frame: &Value) -> Result<std::result::Result<Value, String>> {
    const UNCONFIRMED: &str = "journal lookup was not confirmed";
    let signals = Signals::install()?;
    let mut child = Command::new("reverie-memory-journal");
    child.arg("--journal-only");
    let request = serde_json::to_vec(frame)?;
    let limits = Limits::worker(
        Instant::now() + Duration::from_secs(45),
        crate::OPENCODE_CONTEXT_BOUND,
        &signals,
    );
    match capture::completed(child, Some(&request), limits) {
        Ok(output) if output.success => {
            Ok(serde_json::from_slice(&output.stdout).map_err(|_| UNCONFIRMED.to_owned()))
        }
        Ok(output) => Ok(Err(
            journal_error(&output.stderr).unwrap_or_else(|| UNCONFIRMED.to_owned())
        )),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => Err(error.into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Err(
            "the packaged Office journal client is unavailable".into(),
        )),
        Err(_) => Ok(Err(UNCONFIRMED.into())),
    }
}

fn journal_error(stderr: &[u8]) -> Option<String> {
    let last_line = std::str::from_utf8(stderr).ok()?.lines().last()?;
    let error: Value = serde_json::from_str(last_line).ok()?;
    Some(error.get("error")?.as_str()?.to_owned())
}
