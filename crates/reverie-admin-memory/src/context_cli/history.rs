use super::*;
use crate::opencode_context::Message;
use reverie_contracts::memory::{LegacyHistory, MemoryJsonError};
use reverie_store::memory::{Episode, PrivateContinuity};
use std::{fs, time::UNIX_EPOCH};

pub(super) fn messages(
    config: &MemoryConfiguration,
    records: &mut PrivateContinuity,
    turns: i64,
) -> Result<Vec<Message>> {
    let mut episodes = std::mem::take(&mut records.episodes);
    if !records.history_imported && turns != 0 {
        let mut older = legacy(&config.native_path(MemoryPath::LegacyHistory)?)?;
        older.append(&mut episodes);
        older.sort_by(|a, b| b.created_at.total_cmp(&a.created_at));
        episodes = older;
    }
    let limit = usize::try_from(turns).unwrap_or(usize::MAX);
    let mut admitted = episodes
        .into_iter()
        .take(limit)
        .map_while(|episode| episode.texts)
        .collect::<Vec<_>>();
    admitted.reverse();
    Ok(admitted
        .into_iter()
        .flat_map(|(user, assistant)| {
            [
                Message {
                    role: "user".into(),
                    content: user,
                },
                Message {
                    role: "assistant".into(),
                    content: assistant,
                },
            ]
        })
        .collect())
}

fn legacy(path: &Path) -> Result<Vec<Episode>> {
    let Some(raw) = read_text(path)? else {
        return Ok(Vec::new());
    };
    let history = match LegacyHistory::decode(&raw) {
        Ok(history) => history,
        Err(MemoryJsonError::InvalidJson) => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let modified = fs::metadata(path)?.modified()?;
    let mtime = modified.duration_since(UNIX_EPOCH).map_or_else(
        |error| -error.duration().as_secs_f64(),
        |delta| delta.as_secs_f64(),
    );
    let count = history.episodes().len();
    history
        .episodes()
        .iter()
        .enumerate()
        .rev()
        .map(|(index, episode)| {
            Ok(Episode {
                created_at: mtime - (count - index) as f64 * 60.0,
                texts: Some((scalar(&episode.user)?, scalar(&episode.assistant)?)),
            })
        })
        .collect()
}
