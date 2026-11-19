//! Existing one-time configured history import. Paths and database ownership
//! come from service installation; this is not an operator file-editing CLI.
use reverie_contracts::{memory::MemoryMetadata, storage_identity::MetadataText};
use reverie_host::memory_history::{HistoryCapture, HistoryEntry};
use reverie_store::memory::{EpisodeInput, MemoryError, MemoryStore};
use std::path::Path;

const STATE_KEY: &str = "migrated_legacy_history";

/// Install the batch and marker in one writer-reserved transaction. An old
/// partial batch is preserved and requires an explicit recovery decision.
pub fn migrate_history_atomic(
    store: &MemoryStore,
    path: impl AsRef<Path>,
    importance: f64,
) -> Result<usize, MemoryError> {
    if already_marked(store.get_state(STATE_KEY, None)?) {
        return Ok(0);
    }
    let captured = HistoryCapture::read(path.as_ref())?;
    store.atomic_immediate(|tx| {
        if already_marked(tx.get_state(STATE_KEY, None)?) {
            return Ok(0);
        }
        if tx.has_legacy_history_rows()? {
            return Err(MemoryError::AmbiguousLegacyHistory);
        }
        let Some(captured) = captured else {
            tx.set_state(STATE_KEY, "missing")?;
            return Ok(0);
        };
        let entries = captured.entries();
        let count = entries.len();
        for entry in entries {
            tx.add_episode(episode(entry, importance))?;
        }
        tx.set_state(STATE_KEY, &count.to_string())?;
        Ok(count)
    })
}

fn already_marked(value: Option<String>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

fn episode(entry: HistoryEntry<'_>, importance: f64) -> EpisodeInput {
    let mut input =
        EpisodeInput::from_text(entry.episode.user.clone(), entry.episode.assistant.clone());
    input.importance = importance;
    input.importance_source = MetadataText::from_scalar_text("migrated");
    input.created_at = Some(entry.created_at);
    input.metadata = MemoryMetadata::legacy_history(entry.idle);
    input
}

pub fn migrate_history(
    store: &MemoryStore,
    path: impl AsRef<Path>,
    importance: f64,
) -> Result<usize, MemoryError> {
    if already_marked(store.get_state(STATE_KEY, None)?) {
        return Ok(0);
    }
    let Some(captured) = HistoryCapture::read(path.as_ref())? else {
        store.set_state(STATE_KEY, "missing")?;
        return Ok(0);
    };
    let entries = captured.entries();
    let count = entries.len();
    for entry in entries {
        // Retained compatibility entry point commits each episode separately.
        store.add_episode(episode(entry, importance))?;
    }
    store.set_state(STATE_KEY, &count.to_string())?;
    Ok(count)
}
