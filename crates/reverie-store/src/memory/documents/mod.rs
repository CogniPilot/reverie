//! Named documents on the same MemoryStore connection. No public SQL callback,
//! arbitrary database selector, owner grant or wire-minted ballot approval.
mod ballots;
mod queries;
#[cfg(test)]
mod tests;
mod transaction;
pub use queries::BallotHistory;
mod write;
use super::*;
use ballots::ballot_streak;
pub use ballots::{BallotOutcome, RecordedBallot};
use reverie_contracts::memory_documents::{
    BallotProposal, DocumentBody, DocumentCodecError, SelfModelChange, SelfModelDraft,
};
use reverie_core::memory_documents::{
    BallotCategory, DeveloperName, DocumentName, DocumentRevision, ballot_week,
};
use rusqlite::{OptionalExtension, params};
use std::collections::BTreeMap;
pub use transaction::TransactionDocuments;
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS reverie_documents(name TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL, updated_at REAL NOT NULL); CREATE TABLE IF NOT EXISTS reverie_document_history(name TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, archived_at REAL NOT NULL, PRIMARY KEY(name,revision)); CREATE TABLE IF NOT EXISTS reverie_ballots(category TEXT NOT NULL, week INTEGER NOT NULL, proposal_hash TEXT NOT NULL, proposal TEXT NOT NULL, reason TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY(category,week));";
pub struct MemoryDocuments<'a> {
    store: &'a MemoryStore,
    initial_self: DocumentBody,
    clock: fn() -> f64,
}
struct DocumentContext<'a> {
    store: &'a MemoryStore,
    initial_self: &'a DocumentBody,
    clock: fn() -> f64,
}
pub struct DocumentEnvelope {
    pub revision: DocumentRevision,
    pub body: DocumentBody,
    pub updated_at: Option<f64>,
}
pub struct DocumentHistory {
    pub name: String,
    pub revision: DocumentRevision,
    pub body: String,
    pub archived_at: f64,
}
impl MemoryStore {
    pub fn documents(&self, initial_self: Option<DocumentBody>) -> MemoryDocuments<'_> {
        MemoryDocuments {
            store: self,
            initial_self: DocumentBody::selected_initial_self(initial_self),
            clock: now,
        }
    }
}
impl MemoryDocuments<'_> {
    fn context(&self) -> DocumentContext<'_> {
        DocumentContext {
            store: self.store,
            initial_self: &self.initial_self,
            clock: self.clock,
        }
    }
    pub fn in_transaction<'a, 'connection>(
        &'a self,
        tx: &'a mut MemoryTransaction<'connection>,
    ) -> Result<TransactionDocuments<'a, 'connection>> {
        if !std::ptr::eq(tx.origin, self.store) {
            return Err(MemoryError::DocumentContextMismatch);
        }
        Ok(TransactionDocuments {
            tx,
            context: self.context(),
        })
    }
    /// Explicit startup only. Reads never call this schema initializer.
    pub fn initialize(&self) -> Result<()> {
        self.store.session(|tx| {
            tx.connection_scope(|tx| {
                tx.db.execute_batch(SCHEMA)?;
                Ok(())
            })
        })
    }
    pub fn read(
        &self,
        name: &DocumentName,
        default: Option<DocumentBody>,
    ) -> Result<DocumentEnvelope> {
        self.store.session(|tx| read_on(tx, name, default))
    }
    pub fn self_model(&self) -> Result<DocumentEnvelope> {
        self.read(
            &DocumentName::from_scalar_text("self"),
            Some(self.initial_self.clone()),
        )
    }
    pub fn plan(&self) -> Result<DocumentEnvelope> {
        self.read(
            &DocumentName::from_scalar_text("plan"),
            Some(DocumentBody::plan(&MetadataText::from_scalar_text(
                reverie_core::memory_documents::DEFAULT_PLAN,
            ))),
        )
    }
    pub fn render_self(&self) -> Result<MetadataText> {
        Ok(self.self_model()?.body.render_self()?)
    }
    pub fn brief(
        &self,
        request: &reverie_contracts::memory_documents::BriefRequest,
    ) -> Result<String> {
        let profiles = self
            .profiles()?
            .into_iter()
            .map(|(name, value)| (name, value.body))
            .collect();
        Ok(request.render(&profiles)?)
    }
    pub fn history(&self, name: &DocumentName) -> Result<Vec<DocumentHistory>> {
        self.store.session(|tx| queries::history_on(tx, name))
    }
    pub fn ballot_history(&self) -> Result<Vec<BallotHistory>> {
        self.store.session(|tx| queries::ballots_on(tx))
    }
    pub fn profiles(&self) -> Result<BTreeMap<String, DocumentEnvelope>> {
        let names = self.store.session(|tx| queries::profile_names(tx))?;
        names
            .into_iter()
            .map(|name| {
                let key = name
                    .strip_prefix("developer:")
                    .expect("SQL developer prefix")
                    .to_owned();
                Ok((
                    key,
                    self.read(&DocumentName::from_scalar_text(&name), None)?,
                ))
            })
            .collect()
    }
    pub fn save_profile(
        &self,
        name: &DeveloperName,
        profile: &DocumentBody,
        revision: DocumentRevision,
    ) -> Result<DocumentEnvelope> {
        profile.checked_profile(name)?;
        self.write(
            &DocumentName::from_scalar_text(&format!("developer:{}", name.as_str())),
            profile,
            revision,
        )
    }
}
fn read_on(
    tx: &MemoryTransaction<'_>,
    name: &DocumentName,
    default: Option<DocumentBody>,
) -> Result<DocumentEnvelope> {
    let name = name_text(name)?;
    let row: Option<(i64, String, f64)> = tx
        .db
        .query_row(
            "SELECT revision,body,updated_at FROM reverie_documents WHERE name=?",
            [name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match row {
        Some((revision, body, at)) => Ok(DocumentEnvelope {
            revision: DocumentRevision::try_new(revision)?,
            body: DocumentBody::decode_json(&body)?,
            updated_at: Some(at),
        }),
        None => Ok(DocumentEnvelope {
            revision: DocumentRevision::try_new(0)?,
            body: default.unwrap_or_else(DocumentBody::null),
            updated_at: None,
        }),
    }
}
fn name_text(name: &DocumentName) -> Result<String> {
    name.text()
        .as_text_ref()
        .scalar_text()
        .map(|s| s.into_owned())
        .ok_or_else(|| DocumentCodecError::Text.into())
}
fn sql_text(text: &MetadataText) -> Result<String> {
    text.scalar_text()
        .ok_or_else(|| DocumentCodecError::Text.into())
}
