//! Existing one-time configured history import. Paths and database ownership
//! come from service installation; this is not an operator file-editing CLI.
use reverie_contracts::memory::{LegacyHistory, MemoryJsonError, MemoryMetadata};
use reverie_store::memory::{EpisodeInput, MemoryError, MemoryStore};
use std::{fs, path::Path, time::UNIX_EPOCH};
const STATE_KEY: &str = "migrated_legacy_history";
/// Curated explicit migration. Unlike the retained legacy helper below, this
/// installs the new batch and marker in one writer-reserved transaction. An
/// old partial batch is preserved and requires an explicit recovery decision.
pub fn migrate_history_atomic(
    store: &MemoryStore,
    path: impl AsRef<Path>,
    importance: f64,
) -> Result<usize, MemoryError> {
    if already_marked(store.get_state(STATE_KEY, None)?) {
        return Ok(0);
    }
    let captured = capture(path.as_ref())?;
    store.atomic_immediate(|tx| {
        if already_marked(tx.get_state(STATE_KEY, None)?) {
            return Ok(0);
        }
        if tx.has_legacy_history_rows()? {
            return Err(MemoryError::AmbiguousLegacyHistory);
        }
        let Some((history, modified)) = captured else {
            tx.set_state(STATE_KEY, "missing")?;
            return Ok(0);
        };
        let count = history.episodes().len();
        for (index, pair) in history.episodes().iter().enumerate() {
            tx.add_episode(episode(
                pair,
                importance,
                modified - (count - index) as f64 * 60.0,
            ))?;
        }
        tx.set_state(STATE_KEY, &count.to_string())?;
        Ok(count)
    })
}
fn already_marked(value: Option<String>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}
fn episode(
    pair: &reverie_contracts::memory::LegacyEpisode,
    importance: f64,
    at: f64,
) -> EpisodeInput {
    let mut input = EpisodeInput::from_text(pair.user.clone(), pair.assistant.clone());
    input.importance = importance;
    input.importance_source =
        reverie_contracts::storage_identity::MetadataText::from_scalar_text("migrated");
    input.created_at = Some(at);
    input.metadata = MemoryMetadata::legacy_history(
        pair.user
            .codepoints()
            .iter()
            .copied()
            .take("(idle moment".len())
            .eq("(idle moment".chars().map(u32::from)),
    );
    input
}
fn capture(path: &Path) -> Result<Option<(LegacyHistory, f64)>, MemoryError> {
    let result = (|| -> Result<_, MemoryError> {
        let text = fs::read_to_string(path)?;
        let modified = fs::metadata(path)?.modified()?;
        let modified = match modified.duration_since(UNIX_EPOCH) {
            Ok(v) => v.as_secs_f64(),
            Err(e) => -e.duration().as_secs_f64(),
        };
        Ok((LegacyHistory::decode(&text)?, modified))
    })();
    match result {
        Ok(value) => Ok(Some(value)),
        Err(MemoryError::Io(_) | MemoryError::Json(MemoryJsonError::InvalidJson)) => Ok(None),
        Err(error) => Err(error),
    }
}
pub fn migrate_history(
    store: &MemoryStore,
    path: impl AsRef<Path>,
    importance: f64,
) -> Result<usize, MemoryError> {
    if store
        .get_state(STATE_KEY, None)?
        .is_some_and(|value| !value.is_empty())
    {
        return Ok(0);
    }
    let (history, modified) = match capture(path.as_ref())? {
        Some(value) => value,
        None => {
            store.set_state(STATE_KEY, "missing")?;
            return Ok(0);
        }
    };
    let count = history.episodes().len();
    for (index, pair) in history.episodes().iter().enumerate() {
        let input = episode(pair, importance, modified - (count - index) as f64 * 60.0);
        // Deliberately retain per-episode commits and the final state marker:
        // the source import is not an all-or-nothing reset/re-embedding pass.
        store.add_episode(input)?;
    }
    store.set_state(STATE_KEY, &count.to_string())?;
    Ok(count)
}
