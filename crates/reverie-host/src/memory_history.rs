//! Capture the configured legacy history for the existing memory-store writer.
use reverie_contracts::memory::{LegacyEpisode, LegacyHistory, MemoryJsonError};
use reverie_store::memory::MemoryError;
use std::{fs, path::Path, time::UNIX_EPOCH};

pub struct HistoryCapture {
    history: LegacyHistory,
    modified: f64,
}

pub struct HistoryEntry<'a> {
    pub episode: &'a LegacyEpisode,
    pub created_at: f64,
    pub idle: bool,
}

impl HistoryCapture {
    pub fn read(path: &Path) -> Result<Option<Self>, MemoryError> {
        match Self::read_file(path) {
            Ok(capture) => Ok(Some(capture)),
            Err(MemoryError::Io(_) | MemoryError::Json(MemoryJsonError::InvalidJson)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn read_file(path: &Path) -> Result<Self, MemoryError> {
        let text = fs::read_to_string(path)?;
        let modified = fs::metadata(path)?.modified()?;
        let modified = match modified.duration_since(UNIX_EPOCH) {
            Ok(value) => value.as_secs_f64(),
            Err(error) => -error.duration().as_secs_f64(),
        };
        let history = LegacyHistory::decode(&text)?;
        Ok(Self { history, modified })
    }

    pub fn entries(&self) -> impl ExactSizeIterator<Item = HistoryEntry<'_>> {
        const IDLE_PREFIX: &str = "(idle moment";
        let episodes = self.history.episodes();
        let count = episodes.len();
        episodes
            .iter()
            .enumerate()
            .map(move |(index, episode)| HistoryEntry {
                episode,
                created_at: self.modified - (count - index) as f64 * 60.0,
                idle: episode
                    .user
                    .codepoints()
                    .iter()
                    .copied()
                    .take(IDLE_PREFIX.len())
                    .eq(IDLE_PREFIX.chars().map(u32::from)),
            })
    }
}
