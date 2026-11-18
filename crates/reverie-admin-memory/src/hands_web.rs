//! Parent-bound entry for Hands' bounded public HTTPS reader.
mod destination;
mod page;
mod transport;

use destination::Target;
use reverie_contracts::hands_web::validate_settings;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{io, time::Duration};

const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    ValidateTarget { url: String },
    ValidateSettings { settings: Map<String, Value> },
    Fetch { url: String },
}

pub(crate) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, crate::REQUEST_BOUND)?;
    let result = match serde_json::from_slice(&input)? {
        Request::ValidateTarget { url } => json!({"valid": Target::parse(&url).is_some()}),
        Request::ValidateSettings { settings } => {
            json!({"error": validate_settings(&settings).err()})
        }
        Request::Fetch { url } => {
            let text = fetch(&url)?.ok_or_else(crate::refused)?;
            json!({"text": text})
        }
    };
    crate::write_reply(&result, crate::RESPONSE_BOUND)
}

fn fetch(url: &str) -> io::Result<Option<String>> {
    let Some(target) = Target::parse(url) else {
        return Ok(None);
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        tokio::time::timeout(TIMEOUT, transport::fetch(target))
            .await
            .ok()
            .flatten()
    });
    // A timed-out libc resolver can still be running on Tokio's blocking pool.
    // This one-shot process exits immediately, so it must not join that pool.
    runtime.shutdown_background();
    Ok(result.map(|result| page::render(url, result)))
}
