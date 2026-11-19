//! Install the existing OpenCode profiles and plugins into a dedicated workspace.
mod files;
mod settings;
pub(super) use files::rules;

use clap::Parser;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env,
    ffi::OsString,
    io,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

const BRIDGE: &str = "reverie-opencode-bridge";

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Parser, Deserialize)]
#[serde(deny_unknown_fields)]
#[command(
    name = "reverie-opencode",
    about = "Install an OpenCode workspace for one persistent Reverie agent."
)]
struct Install {
    /// Dedicated workspace outside the repository.
    #[arg(long, value_name = "WORKSPACE")]
    install: PathBuf,
    #[arg(long, default_value = "local_agent/MODEL_ID")]
    model: String,
    #[arg(long)]
    instance: Option<PathBuf>,
    #[arg(long)]
    api_base: Option<String>,
    #[arg(long, default_value_t = 32768)]
    context_window: u64,
    #[arg(long, default_value_t = 4096)]
    output_tokens: u64,
    #[arg(long)]
    api_key_env: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyBridge {
    python: PathBuf,
    source: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Worker {
    install: Install,
    legacy: LegacyBridge,
}

pub(super) fn entry(args: Vec<OsString>) -> ExitCode {
    if !args.iter().skip(1).any(|arg| {
        matches!(arg.to_str(), Some("--install" | "-h" | "--help"))
            || arg
                .to_str()
                .is_some_and(|arg| arg.starts_with("--install="))
    }) {
        let failure = Command::new(BRIDGE).args(args.into_iter().skip(1)).exec();
        eprintln!(
            "{}",
            json!({"error": format!("OpenCode compatibility bridge unavailable: {failure}")})
        );
        return ExitCode::FAILURE;
    }
    let explicit_model = args
        .iter()
        .skip(1)
        .any(|arg| arg == "--model" || arg.to_str().is_some_and(|arg| arg.starts_with("--model=")));
    let mut args = Install::parse_from(args);
    if !explicit_model {
        args.model = env::var("REVERIE_MODEL")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or(args.model);
    }
    match install(args, None)
        .and_then(|value| Ok(crate::write_reply(&value, crate::RESPONSE_BOUND)?))
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", json!({"error": error.to_string()}));
            ExitCode::FAILURE
        }
    }
}

pub(super) fn worker(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, crate::REQUEST_BOUND)?;
    let job: Worker = serde_json::from_slice(&input)?;
    let output = install(job.install, Some(job.legacy))
        .unwrap_or_else(|error| json!({"error": error.to_string()}));
    crate::write_reply(&output, crate::RESPONSE_BOUND)
}

fn install(args: Install, legacy: Option<LegacyBridge>) -> Result<Value> {
    let workspace = absolute_workspace(&args.install)?;
    let instance = args
        .instance
        .as_deref()
        .map(reverie_host::memory_instance::LoadedMemoryInstance::load)
        .transpose()?;
    let configuration =
        settings::configuration(&args, instance.as_ref().map(|value| value.configuration()))?;
    let instance_path = instance
        .as_ref()
        .map(|value| {
            value
                .configuration_path()
                .codepoints()
                .into_iter()
                .map(char::from_u32)
                .collect::<Option<String>>()
                .ok_or("instance path requires Unicode text")
        })
        .transpose()?;
    let mut marker = match legacy {
        Some(legacy) => serde_json::to_value(legacy)?,
        None => json!({"bridge": BRIDGE}),
    };
    marker["cycle_managed"] = json!(env::var("REVERIE_CYCLE_MANAGED").as_deref() == Ok("1"));
    if let Some(path) = &instance_path {
        marker["instance"] = json!(path);
    }
    let role = settings::role(instance.as_ref().map(|value| value.configuration()))?;
    let files = files::Workspace::open(&workspace)?;
    files.install(configuration, marker, &role, instance_path.as_deref())?;
    Ok(json!({"workspace": files.root(), "model": args.model}))
}

fn absolute_workspace(path: &Path) -> Result<PathBuf> {
    let path = if let Ok(relative) = path.strip_prefix("~") {
        let home = env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .ok_or("home directory unavailable")?;
        PathBuf::from(home).join(relative)
    } else if path.is_absolute() {
        path.to_owned()
    } else {
        env::current_dir()?.join(path)
    };
    if path.as_os_str().is_empty() || path.parent().is_none() {
        return Err("select a dedicated runtime workspace".into());
    }
    Ok(path)
}

pub(super) fn permissions(container_admin: bool) -> Value {
    if container_admin {
        json!({"*":"allow", "reverie_return":"ask"})
    } else {
        serde_json::from_str(include_str!("../opencode-assets/permissions.json"))
            .expect("embedded OpenCode permission policy")
    }
}
