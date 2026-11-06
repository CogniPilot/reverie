//! Existing one-time configured history import. Paths and database ownership
//! come from service installation; this is not an operator file-editing CLI.
use reverie_contracts::memory::{LegacyHistory, MemoryJsonError, MemoryMetadata};
use reverie_store::memory::{EpisodeInput, MemoryError, MemoryStore};
use std::{fs, path::Path, time::UNIX_EPOCH};
const STATE_KEY: &str = "migrated_legacy_history";
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
    let path = path.as_ref();
    let captured = (|| -> Result<_, MemoryError> {
        let text = fs::read_to_string(path)?;
        let modified = fs::metadata(path)?.modified()?;
        let modified = match modified.duration_since(UNIX_EPOCH) {
            Ok(v) => v.as_secs_f64(),
            Err(e) => -e.duration().as_secs_f64(),
        };
        Ok((LegacyHistory::decode(&text)?, modified))
    })();
    let (history, modified) = match captured {
        Ok(value) => value,
        Err(MemoryError::Io(_) | MemoryError::Json(MemoryJsonError::InvalidJson)) => {
            store.set_state(STATE_KEY, "missing")?;
            return Ok(0);
        }
        Err(error) => return Err(error),
    };
    let count = history.episodes().len();
    for (index, pair) in history.episodes().iter().enumerate() {
        let mut input = EpisodeInput::from_text(pair.user.clone(), pair.assistant.clone());
        input.importance = importance;
        input.importance_source =
            reverie_contracts::storage_identity::MetadataText::from_scalar_text("migrated");
        input.created_at = Some(modified - (count - index) as f64 * 60.0);
        input.metadata = MemoryMetadata::legacy_history(
            pair.user
                .codepoints()
                .iter()
                .copied()
                .take("(idle moment".len())
                .eq("(idle moment".chars().map(u32::from)),
        );
        // Deliberately retain per-episode commits and the final state marker:
        // the source import is not an all-or-nothing reset/re-embedding pass.
        store.add_episode(input)?;
    }
    store.set_state(STATE_KEY, &count.to_string())?;
    Ok(count)
}
