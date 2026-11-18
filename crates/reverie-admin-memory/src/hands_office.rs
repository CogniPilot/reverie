//! Project only the owner-enabled Office environment for a Hands coding task.
use crate::{configuration, refused};
use reverie_core::{ids::ProfileSessionId, office_relay::loopback_port};
use reverie_store::storage_identity;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env,
    ffi::OsStr,
    io,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    session: String,
    config_path: Option<PathBuf>,
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, crate::REQUEST_BOUND)?;
    let request: Request = serde_json::from_slice(&input)?;
    crate::write_reply(&scoped_environment(request)?, crate::RESPONSE_BOUND)
}

fn scoped_environment(request: Request) -> io::Result<Value> {
    let session = ProfileSessionId::parse(&request.session).map_err(|_| refused())?;
    if env::var_os("REVERIE_SESSION_ID")
        .is_some_and(|current| current != OsStr::new(session.as_str()))
    {
        return Err(refused());
    }
    let origin = env::var("REVERIE_API_URL").map_err(|_| refused())?;
    loopback_port(&origin).ok_or_else(refused)?;
    let root = configured_root(&session, request.config_path.as_deref())?;
    Ok(json!({
        "REVERIE_SCOPED_OFFICE": "1",
        "REVERIE_MUX": "1",
        "REVERIE_SESSION_ID": session.as_str(),
        "REVERIE_API_URL": origin.trim_end_matches('/'),
        "REVERIE_AGENT_HOME": configuration::agent_home()?.to_str().ok_or_else(refused)?,
        "REVERIE_DATA_DIR": root.to_str().ok_or_else(refused)?,
    }))
}

fn configured_root(session: &ProfileSessionId, loaded: Option<&Path>) -> io::Result<PathBuf> {
    let root: PathBuf = configuration::data_root()?.components().collect();
    let selected = configuration::session_file(&root, session);
    // Keep the old missing-tail behavior for standalone Hands configurations.
    storage_identity::canonical(&selected).map_err(|_| refused())?;
    if let Some(loaded) = loaded {
        let loaded = std::path::absolute(loaded)?;
        if loaded != selected && loaded.canonicalize().as_deref().ok() != Some(&selected) {
            return Err(refused());
        }
    }
    Ok(root)
}
