//! Compatibility requests leave writes and model orchestration with legacy chat.
use reverie_contracts::memory::decode_mood;
use reverie_core::{
    memory::{RATING_SUFFIX, RATING_SYSTEM, importance_rating},
    posix_text,
};
use reverie_host::memory_history::HistoryCapture;
use serde::{Deserialize, Serialize};
use std::{ffi::OsString, io, os::unix::ffi::OsStringExt, path::PathBuf};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    MoodView { raw: Option<String>, now: f64 },
    RatingPrompt,
    RatingScore { points: Vec<u32> },
    History { path: Vec<u32> },
}

#[derive(Serialize)]
struct HistoryEpisode<'a> {
    user: &'a [u32],
    assistant: &'a [u32],
    created_at: f64,
    idle: bool,
}

#[derive(Serialize)]
struct HistoryReply<'a> {
    episodes: Option<Vec<HistoryEpisode<'a>>>,
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let bound = crate::TURN_CAPTURE_BOUND;
    let request = serde_json::from_slice(&crate::worker_input(parent, bound)?)?;
    match request {
        Request::MoodView { raw, now } => {
            let description = decode_mood(raw.as_deref()).decayed(now).describe();
            crate::write_reply(&serde_json::json!({ "description": description }), bound)
        }
        Request::RatingPrompt => crate::write_reply(
            &serde_json::json!({
                "system": RATING_SYSTEM,
                "suffix": RATING_SUFFIX,
                "max_tokens": 8,
                "temperature": 0.0,
                "max_chars": 40,
            }),
            bound,
        ),
        Request::RatingScore { points } => crate::write_reply(
            &serde_json::json!({ "score": importance_rating(&points) }),
            bound,
        ),
        Request::History { path } => history(&path),
    }
}

fn history(path: &[u32]) -> io::Result<()> {
    let path = PathBuf::from(OsString::from_vec(
        posix_text::encode(path).map_err(io::Error::other)?,
    ));
    let capture = HistoryCapture::read(&path).map_err(io::Error::other)?;
    let episodes = capture.as_ref().map(|capture| {
        capture
            .entries()
            .map(|entry| HistoryEpisode {
                user: entry.episode.user.codepoints(),
                assistant: entry.episode.assistant.codepoints(),
                created_at: entry.created_at,
                idle: entry.idle,
            })
            .collect()
    });
    // Existing local history files have no reply-sized transcript limit.
    serde_json::to_writer(io::stdout().lock(), &HistoryReply { episodes })?;
    Ok(())
}
