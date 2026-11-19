//! Hand off to the harness and model already selected by the Office session.
mod claude_launch;
mod hands_launch;
mod office;
mod persistent_ids;

use clap::{Parser, ValueEnum};
use reverie_contracts::memory_instance::primary_agent;
use reverie_host::memory_instance::LoadedMemoryInstance;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env, fs, io,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

type Result<T> = std::result::Result<T, &'static str>;
type LaunchResult<T> = std::result::Result<T, LaunchError>;

enum LaunchError {
    Usage(&'static str),
    Failed(&'static str),
}
impl From<&'static str> for LaunchError {
    fn from(message: &'static str) -> Self {
        Self::Failed(message)
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum Mode {
    Opencode,
    Codex,
    Claude,
}
impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Opencode => "opencode",
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }

    fn model(self, session: &Value) -> LaunchResult<&str> {
        if session["mode"].as_str() != Some(self.as_str()) {
            return Err(LaunchError::Usage(
                "adapter does not match the current Reverie session",
            ));
        }
        let value = match self {
            Self::Opencode => &session["openCodeConfig"]["model"],
            Self::Codex => &session["codexConfig"]["model"],
            Self::Claude => &session["model"],
        };
        value
            .as_str()
            .filter(|model| !model.trim().is_empty() && !model.contains('\0'))
            .ok_or_else(|| "the runtime policy must select a model explicitly".into())
    }

    fn argv(self, model: &str, agent: &str) -> Vec<String> {
        let mut args = vec![self.as_str()];
        if matches!(self, Self::Opencode) {
            args.extend(["--agent", agent]);
        }
        args.extend(["--model", model]);
        args.into_iter().map(str::to_owned).collect()
    }
}

#[derive(Parser)]
#[command(about = "Launch the harness and model selected in the current Reverie session")]
struct Args {
    mode: Mode,
    /// Print the selected model and argument vector without starting the harness.
    #[arg(long)]
    describe: bool,
}

#[derive(Deserialize)]
struct Marker {
    instance: Option<PathBuf>,
}

fn marker_instance() -> Result<Option<PathBuf>> {
    match fs::read_to_string(".reverie-instance") {
        Ok(text) => serde_json::from_str::<Marker>(&text)
            .map(|marker| marker.instance.filter(|path| !path.as_os_str().is_empty()))
            .map_err(|_| "invalid .reverie-instance marker"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("could not read .reverie-instance"),
    }
}

fn required_setting(name: &str) -> LaunchResult<String> {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or(LaunchError::Usage(
            "Reverie API URL and session identity are required",
        ))
}

fn run(args: Args) -> LaunchResult<()> {
    let api = required_setting("REVERIE_API_URL")?;
    let id = required_setting("REVERIE_SESSION_ID")?;
    let response = office::sessions(&api, &id)?;
    let model = args.mode.model(office::resolve_session(&response, &id)?)?;
    let marker = marker_instance()?;
    let instance_path = marker.clone().or_else(|| {
        env::var_os("REVERIE_INSTANCE_CONFIG")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
    });
    let instance = instance_path
        .as_deref()
        .map(LoadedMemoryInstance::load)
        .transpose()
        .map_err(|_| "could not load the selected Reverie instance")?;
    let agent = primary_agent(instance.as_ref().map(LoadedMemoryInstance::configuration));
    let argv = args.mode.argv(model, agent);
    if args.describe {
        println!(
            "{}",
            json!({"mode":args.mode.as_str(),"model":model,"argv":argv})
        );
        return Ok(());
    }
    launch(&argv, marker.as_deref()).map_err(Into::into)
}

fn launch(argv: &[String], marker: Option<&Path>) -> Result<()> {
    let [executable, args @ ..] = argv else {
        return Err("no harness selected");
    };
    let mut command = Command::new(executable);
    command.args(args);
    if let Some(path) = marker {
        command.env("REVERIE_INSTANCE_CONFIG", path);
    }
    let _error = command.exec();
    Err("could not start the selected harness")
}

fn main() -> ExitCode {
    let mut raw = env::args_os().skip(1);
    match raw.next().as_deref().and_then(std::ffi::OsStr::to_str) {
        Some("--claude-launch") => {
            let plan = raw.next().filter(|_| raw.next().is_none());
            return claude_launch::entry(plan.as_deref());
        }
        Some("--hands-launch") => return hands_launch::entry(raw.collect()),
        Some("--persistent-ids") => return persistent_ids::entry(raw),
        _ => {}
    }
    match run(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(LaunchError::Usage(error)) => {
            eprintln!("reverie-backend: {error}");
            ExitCode::from(2)
        }
        Err(LaunchError::Failed(error)) => {
            eprintln!("reverie-backend: {error}");
            ExitCode::FAILURE
        }
    }
}
