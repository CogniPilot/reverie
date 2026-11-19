use crate::offline_store::{observation_reply, path};
use reverie_host::worker_nix::offline_qualification::mount_custody;
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use std::{io, path::PathBuf};

// A raw Docker batch is capped at 16 MiB. ASCII wire JSON can expand Unicode
// paths from two UTF-8 bytes to six ASCII bytes per codepoint.
const REQUEST_BOUND: usize = 52 * 1024 * 1024;

#[derive(Deserialize)]
struct HostPath(#[serde(deserialize_with = "path")] PathBuf);

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Settled {
        rows: Box<RawValue>,
        stores: [HostPath; 2],
    },
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let raw = crate::worker_input(parent, REQUEST_BOUND)?;
    let request: Request = serde_json::from_slice(&raw)?;
    observation_reply(request.inspect(), crate::REQUEST_BOUND)
}

impl Request {
    fn inspect(self) -> Result<Value, Box<dyn std::error::Error>> {
        match self {
            Self::Settled { rows, stores } => {
                mount_custody::settled(&stores.map(|path| path.0), rows.get().as_bytes())?;
            }
        }
        Ok(json!({"bytes": ""}))
    }
}
