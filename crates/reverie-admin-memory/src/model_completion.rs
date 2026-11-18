//! Non-streaming completion transport for the remaining legacy model callers.
mod reply;

use crate::TURN_CAPTURE_BOUND;
use reverie_core::PythonText;
use reverie_host::embeddings::model_api::{Client, Route};
use serde::Deserialize;
use serde_json::json;
use std::{env, io, io::Write, time::Duration};

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Complete {
        url: String,
        body: String,
        timeout: f64,
        key_env: Option<String>,
    },
    Clean {
        points: Vec<u32>,
        limit: i64,
    },
    LimitWords {
        points: Vec<u32>,
        limit: i64,
    },
}

fn key_from_environment(name: Option<String>) -> io::Result<Option<String>> {
    let Some(name) = name else {
        return Ok(None);
    };
    if name.is_empty() || name.contains(['\0', '=']) {
        return Err(crate::refused());
    }
    env::var(name)
        .ok()
        .filter(|key| !key.is_empty())
        .map(Some)
        .ok_or_else(crate::refused)
}

fn complete(url: &str, body: String, timeout: f64, key_env: Option<String>) -> io::Result<()> {
    let base = url
        .strip_suffix("/chat/completions")
        .ok_or_else(crate::refused)?;
    let timeout = Duration::try_from_secs_f64(timeout).map_err(io::Error::other)?;
    let client =
        Client::new(base.to_owned(), timeout, MAX_RESPONSE_BYTES).map_err(|_| crate::refused())?;
    let key = key_from_environment(key_env)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(client.request(
        Route::Completions,
        Some(body.into_bytes()),
        key.as_deref(),
    ));
    runtime.shutdown_background();
    io::stdout()
        .lock()
        .write_all(&result.map_err(|_| crate::refused())?)
}

fn format(
    points: Vec<u32>,
    limit: i64,
    transform: fn(&PythonText, i64) -> Vec<u32>,
) -> io::Result<()> {
    let text = PythonText::try_new(points).map_err(io::Error::other)?;
    let points = transform(&text, limit);
    crate::write_reply(&json!({ "points": points }), TURN_CAPTURE_BOUND)
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, TURN_CAPTURE_BOUND)?;
    match serde_json::from_slice::<Request>(&input)? {
        Request::Complete {
            url,
            body,
            timeout,
            key_env,
        } => complete(&url, body, timeout, key_env),
        Request::Clean { points, limit } => format(points, limit, reply::clean),
        Request::LimitWords { points, limit } => format(points, limit, reply::limit_words),
    }
}
