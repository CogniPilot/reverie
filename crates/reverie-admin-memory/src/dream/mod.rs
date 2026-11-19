//! Dream planning and settlement for the existing chat and cycle callers.
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
use serde_json::{Value, json};
use std::io;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Sample {
        now: f64,
        episodes: Vec<(i64, f64, f64, bool)>,
    },
    Prompt {
        now: f64,
        mood: Option<String>,
        beliefs: String,
        revisable: bool,
        creative: String,
        system: Option<String>,
        episodes: Vec<(i64, String)>,
    },
    Reply {
        points: Vec<u32>,
        now: f64,
        mood: Option<String>,
        weight: f64,
    },
    Recall {
        text: String,
        meta: String,
    },
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let bound = crate::TURN_CAPTURE_BOUND;
    let request = serde_json::from_slice(&crate::worker_input(parent, bound)?)?;
    let value = match request {
        Request::Sample { now, episodes } => json!({ "ids": sample(episodes, now)? }),
        Request::Prompt {
            now,
            mood,
            beliefs,
            revisable,
            creative,
            system,
            episodes,
        } => json!({
            "system": prompt::system(system.as_deref()),
            "max_tokens": 800,
            "temperature": 1.0,
            "max_chars": 6000,
            "user": prompt::user(
                &episodes, &beliefs, revisable, &creative,
                decode_mood(mood.as_deref()).decayed(now).describe(),
            ),
        }),
        Request::Reply {
            points,
            now,
            mood,
            weight,
        } => {
            let parsed = parse(points)?;
            json!({ "dream": parsed.map(|reply| wire(&reply, mood.as_deref(), now, weight)) })
        }
        Request::Recall { text, meta } => {
            let recalled = MemoryMetadata::decode(&meta)
                .and_then(|meta| meta.waking_recall(&text))
                .map_err(io::Error::other)?;
            json!({ "points": recalled.codepoints() })
        }
    };
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

fn wire(reply: &DreamReply, mood: Option<&str>, now: f64, weight: f64) -> Value {
    let tone = reply.tone.as_str();
    let ideas = reply
        .ideas
        .iter()
        .map(|idea| {
            json!({
                "hypothesis": idea.hypothesis.codepoints(),
                "check": idea.check.codepoints(),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "text": reply.dream.codepoints(),
        "recall": reply.recall.codepoints(),
        "tone": tone,
        "ideas": ideas,
        "mood": updated_mood(tone, mood, now, weight),
    })
}

pub(crate) fn updated_mood(tone: &str, mood: Option<&str>, now: f64, weight: f64) -> String {
    encode_mood(decode_mood(mood).decayed(now).nudge_tone(tone, weight, now))
}
