use base64::{Engine, engine::general_purpose::STANDARD};
use reverie_host::worker_nix::offline_qualification;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io, path::PathBuf};

const QUALIFICATION_REPLY_BOUND: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Target {
        target: PathBuf,
        now: f64,
    },
    Profiles {
        home: Vec<u32>,
        nix: Vec<u32>,
        entries: usize,
    },
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, crate::REQUEST_BOUND)?;
    let request: Request = serde_json::from_slice(&input)?;
    let reply = request.execute().unwrap_or_else(|error| {
        let errno = error
            .downcast_ref::<io::Error>()
            .and_then(io::Error::raw_os_error);
        json!({"error": error.to_string(), "errno": errno})
    });
    crate::write_reply(&reply, QUALIFICATION_REPLY_BOUND)
}

impl Request {
    fn execute(self) -> Result<Value, Box<dyn std::error::Error>> {
        match self {
            Self::Target { target, now } => {
                let qualified = offline_qualification::inspect(&target, now)?;
                Ok(json!({
                    "bytes": STANDARD.encode(qualified.bytes),
                    "targetDigest": qualified.digest,
                    "evidencePaths": qualified.evidence_paths,
                }))
            }
            Self::Profiles { home, nix, entries } => Ok(
                json!({ "bytes": STANDARD.encode(offline_qualification::inventory(&home, &nix, entries)?) }),
            ),
        }
    }
}
