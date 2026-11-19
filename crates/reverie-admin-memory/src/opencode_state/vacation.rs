//! Publish vacation only after the existing vote and a durable SQLite archive.
mod archive;

use super::{
    Result,
    documents::{body, decode, envelope, name, outcome},
};
use nix::fcntl::{Flock, FlockArg};
use reverie_contracts::{memory_documents::BallotProposal, storage_identity::MetadataText};
use reverie_core::{memory::trim_text, memory_documents::BallotCategory};
use reverie_store::memory::{MemoryDocuments, MemoryStore};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

#[derive(Deserialize)]
pub(super) struct Request {
    reason: Option<String>,
    handoff: Option<String>,
}

impl Request {
    pub(super) fn apply(
        self,
        store: &MemoryStore,
        docs: &MemoryDocuments<'_>,
        data: &Path,
    ) -> Result<Value> {
        let reason = trim_text(self.reason.as_deref().unwrap_or_default());
        let handoff = trim_text(self.handoff.as_deref().unwrap_or_default());
        if reason.is_empty() || handoff.is_empty() {
            return Err("vacation requires a reason and a final handoff".into());
        }
        let _lock = lock(data)?;
        let lifecycle = name("lifecycle");
        let current = docs.read(&lifecycle, Some(decode(&json!({"mode":"active"}))?))?;
        let lifecycle_body = body(&current)?;
        let mode = lifecycle_body["mode"]
            .as_str()
            .ok_or("invalid lifecycle mode")?;
        if mode == "vacation" {
            return envelope(current);
        }
        let ballot = docs.vote(
            &BallotCategory::parse("vacation")?,
            &BallotProposal::decode_json(r#"{"mode":"vacation"}"#)?,
            &MetadataText::from_scalar_text(reason),
        )?;
        if !ballot.outcome().approved {
            return Ok(json!({"mode":"active", "ballot":outcome(ballot.outcome()),
                             "next_action":"Remain active; reconsider next week"}));
        }
        let record = archive::create(store, data, reason, handoff)?;
        // A stale writer or uncertain commit leaves the verified snapshot
        // available. Its bytes are never deleted after lifecycle publication
        // has been attempted.
        envelope(docs.write(&lifecycle, &decode(&record)?, current.revision)?)
    }
}

fn lock(data: &Path) -> Result<Flock<File>> {
    let file = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(data.join("vacation-archive.lock"))?;
    if !file.metadata()?.is_file() {
        return Err("vacation archive lock must be a regular file".into());
    }
    Flock::lock(file, FlockArg::LockExclusiveNonblock)
        .map_err(|(_, error)| std::io::Error::from(error).into())
}
