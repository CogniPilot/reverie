//! Room discovery, stable polling order, and reply-claim transitions for Hands.
mod driver;
mod file;
pub(super) use file::{load as load_state, save as save_state};
mod rooms;
mod state;

use crate::TURN_CAPTURE_BOUND;
pub(super) use driver::run_tick;
use serde::Deserialize;
use serde_json::{json, value::RawValue};
use std::{io, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Load { path: PathBuf },
    Save { path: PathBuf, data: Box<RawValue> },
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, TURN_CAPTURE_BOUND)?;
    let request = serde_json::from_slice(&input)?;
    dispatch(request)
}

fn dispatch(request: Request) -> io::Result<()> {
    let output = match request {
        // Keep the ordering of existing JSON objects, including pending coding receipts.
        Request::Load { path } => {
            return crate::write_reply(&file::load(&path)?, TURN_CAPTURE_BOUND);
        }
        Request::Save { path, data } => {
            file::save(&path, data.get().as_bytes())?;
            json!({ "saved": true })
        }
    };
    crate::write_reply(&output, TURN_CAPTURE_BOUND)
}

#[cfg(test)]
mod tests;
