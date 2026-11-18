//! Room discovery, stable polling order, and reply-claim transitions for Hands.
mod file;
mod rooms;
mod state;

use crate::{TURN_CAPTURE_BOUND, hands_addressing::Scope};
use serde::Deserialize;
use serde_json::{Map, Value, json, value::RawValue};
use state::{Change, Claim, Room};
use std::{io, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Rooms {
        listed: Vec<Value>,
        state: Map<String, Value>,
        cap: usize,
    },
    Scan {
        room: Box<Room>,
        scope: Scope,
        history: Vec<Value>,
        latest: Option<String>,
    },
    Settlement {
        claim: Claim,
        session: String,
        history: Vec<Value>,
    },
    Change {
        room: Box<Room>,
        event: Change,
    },
    Load {
        path: PathBuf,
    },
    Save {
        path: PathBuf,
        data: Box<RawValue>,
    },
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, TURN_CAPTURE_BOUND)?;
    let request = serde_json::from_slice(&input)?;
    dispatch(request)
}

fn dispatch(request: Request) -> io::Result<()> {
    let output = match request {
        Request::Rooms { listed, state, cap } => rooms::reconcile(&listed, &state, cap),
        Request::Scan {
            mut room,
            scope,
            history,
            latest,
        } => {
            if room.initialize(&history, latest) {
                json!({ "initial": room })
            } else {
                json!({ "pending": room.pending(&scope, &history) })
            }
        }
        Request::Settlement {
            claim,
            session,
            history,
        } => {
            json!({ "disposition": claim.disposition(&session, &history) })
        }
        Request::Change { mut room, event } => {
            room.apply(event)?;
            json!({ "room": room })
        }
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
