//! Dream planning and settlement shared by native maintenance.
pub(crate) mod prompt;

use reverie_contracts::memory::{
    DreamReply, MemoryMetadata, decode_mood, dream_reply, encode_mood,
};
use reverie_core::{
    PythonText,
    memory::{DREAM_DRAWS, DreamEpisode, dream_sample},
};
use reverie_host::memory_screen::MemoryScreen;
use serde::Deserialize;
use serde_json::json;
use std::io;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Recall { text: String, meta: String },
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let bound = crate::TURN_CAPTURE_BOUND;
    let Request::Recall { text, meta } =
        serde_json::from_slice(&crate::worker_input(parent, bound)?)?;
    let recalled = MemoryMetadata::decode(&meta)
        .and_then(|meta| meta.waking_recall(&text))
        .map_err(io::Error::other)?;
    let value = json!({ "points": recalled.codepoints() });
    crate::write_reply(&value, bound)
}

pub(crate) fn sample(episodes: Vec<(i64, f64, f64, bool)>, now: f64) -> io::Result<Vec<i64>> {
    let rows = episodes
        .into_iter()
        .map(|(id, created_at, importance, idle)| DreamEpisode {
            id,
            created_at,
            importance,
            idle,
        })
        .collect::<Vec<_>>();
    let mut bytes = [0; DREAM_DRAWS * size_of::<u64>()];
    getrandom::getrandom(&mut bytes).map_err(|_| io::Error::other("dream entropy unavailable"))?;
    let mut draws = [0.0; DREAM_DRAWS];
    for (draw, bytes) in draws.iter_mut().zip(bytes.chunks_exact(size_of::<u64>())) {
        let bits = u64::from_ne_bytes(bytes.try_into().expect("fixed draw width"));
        *draw = (bits >> 11) as f64 / (1_u64 << 53) as f64;
    }
    dream_sample(&rows, now, draws).ok_or_else(|| io::Error::other("dream weights refused"))
}

pub(crate) fn parse(points: Vec<u32>) -> io::Result<Option<DreamReply>> {
    let raw = PythonText::try_new(points).map_err(io::Error::other)?;
    let mut screen = None;
    dream_reply(&raw, |text| {
        if screen.is_none() {
            screen = Some(MemoryScreen::capture_current().map_err(io::Error::other)?);
        }
        let verdict = screen
            .as_ref()
            .expect("captured policy")
            .check(text)
            .map_err(io::Error::other)?;
        Ok(verdict.is_empty())
    })
}

pub(crate) fn updated_mood(tone: &str, mood: Option<&str>, now: f64, weight: f64) -> String {
    encode_mood(decode_mood(mood).decayed(now).nudge_tone(tone, weight, now))
}
