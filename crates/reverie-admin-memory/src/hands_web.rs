//! Parent-bound entry for the Hands web tools.
mod destination;
mod diagnostic;
mod page;
mod search;
mod transport;

use destination::Target;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{future::Future, io, path::PathBuf, time::Duration};

const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    ValidateTarget {
        url: String,
    },
    Fetch {
        url: String,
    },
    Search {
        query: String,
        settings: Map<String, Value>,
    },
    AppendDiagnostic {
        path: PathBuf,
        line: String,
    },
}

pub(crate) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, crate::REQUEST_BOUND)?;
    let result = match serde_json::from_slice(&input)? {
        Request::ValidateTarget { url } => json!({"valid": valid_target(&url)}),
        Request::Fetch { url } => {
            let text = fetch(&url)?.ok_or_else(crate::refused)?;
            json!({"text": text})
        }
        Request::Search { query, settings } => {
            let search = search::Search::new(&query, &settings).ok_or_else(crate::refused)?;
            let text = bounded(search.timeout(), search.run())?.ok_or_else(crate::refused)?;
            json!({"text": text})
        }
        Request::AppendDiagnostic { path, line } => {
            diagnostic::append(&path, line)?;
            json!({"ok": true})
        }
    };
    crate::write_reply(&result, crate::RESPONSE_BOUND)
}

pub(super) fn valid_target(url: &str) -> bool {
    Target::parse(url).is_some()
}

fn fetch(url: &str) -> io::Result<Option<String>> {
    let Some(target) = Target::parse(url) else {
        return Ok(None);
    };
    Ok(bounded(TIMEOUT, transport::fetch(target))?.map(|result| page::render(url, result)))
}

fn bounded<T>(
    timeout: Duration,
    request: impl Future<Output = Option<T>>,
) -> io::Result<Option<T>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result =
        runtime.block_on(async { tokio::time::timeout(timeout, request).await.ok().flatten() });
    // A timed-out libc resolver can still be running on Tokio's blocking pool.
    // This one-shot process exits immediately, so it must not join that pool.
    runtime.shutdown_background();
    Ok(result)
}
