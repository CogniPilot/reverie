//! The standalone continuation command selects one explicit local instance.
//! It uses the OpenCode renderer with a read-only view of existing state.
mod history;
mod system;

use crate::opencode_context::{Context, Limits};
use clap::{Parser, ValueEnum};
use reverie_contracts::{
    memory_documents::DocumentBody,
    memory_instance::{MemoryInstance, identity_context},
    storage_identity::MetadataText,
};
use reverie_core::{memory_documents::DEFAULT_PLAN, memory_instance::SharedRoomTone};
use reverie_host::memory_instance::LoadedMemoryInstance;
use reverie_store::memory::{Continuity, ContinuityScope, NativeMemoryRead};
use std::{
    env,
    fs::OpenOptions,
    io::{self, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::ExitCode,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Copy, ValueEnum)]
enum Channel {
    Work,
    Private,
}

#[derive(Parser)]
#[command(
    name = "reverie-context",
    about = "Load an agent's durable identity and bounded task context from any backend."
)]
struct Arguments {
    /// Explicit external instance configuration, or REVERIE_INSTANCE_CONFIG.
    #[arg(long)]
    instance: Option<PathBuf>,
    #[arg(long, value_enum, default_value = "work")]
    channel: Channel,
    #[arg(long, default_value_t = 16_384)]
    context_window: u64,
    #[arg(long, default_value_t = 4096)]
    output_tokens: u64,
    #[arg(long, default_value_t = 0)]
    occupied_tokens: u64,
}

pub(super) fn entry() -> ExitCode {
    use clap::CommandFactory;
    let mut arguments = Arguments::parse();
    if arguments.instance.is_none() {
        arguments.instance = env::var_os("REVERIE_INSTANCE_CONFIG")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
    }
    if arguments.instance.is_none() {
        Arguments::command()
            .error(
                clap::error::ErrorKind::MissingRequiredArgument,
                "select an explicit external instance",
            )
            .exit();
    }
    match prompt(arguments)
        .and_then(|text| writeln!(io::stdout().lock(), "{text}").map_err(Into::into))
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("reverie-context: {error}");
            ExitCode::FAILURE
        }
    }
}

fn prompt(arguments: Arguments) -> Result<String> {
    let limits = Limits {
        window: arguments.context_window,
        output: arguments.output_tokens,
        occupied: arguments.occupied_tokens,
    };
    if !(1024..=10_000_000).contains(&limits.window) {
        return Err("unsupported context window".into());
    }
    let path = arguments
        .instance
        .as_deref()
        .ok_or("select an explicit external instance")?;
    let loaded = LoadedMemoryInstance::load(path)?;
    let directory = loaded.native_data_directory()?;
    let fields = loaded.configuration();
    let profile = match arguments.channel {
        Channel::Work => None,
        Channel::Private => read_text(&directory.join("profile.md"))?,
    };
    let turns = env_number("REVERIE_SHORT_TERM_TURNS", 20);
    let scope = match arguments.channel {
        Channel::Work => ContinuityScope::Shared,
        Channel::Private => ContinuityScope::Private {
            turns,
            derive_profile: profile.is_none(),
        },
    };
    let records = NativeMemoryRead::read_continuity(&directory.join("memory.sqlite"), scope)?;
    render(fields, records, &directory, profile, turns, limits)
}

fn render(
    instance: &MemoryInstance,
    records: Continuity,
    directory: &Path,
    profile: Option<String>,
    turns: i64,
    limits: Limits,
) -> Result<String> {
    let initial = records.self_model.is_none();
    let model = records
        .self_model
        .map_or_else(|| instance.initial_model(), Ok)?;
    let (system, messages, social_room) = match records.private {
        Some(mut data) => {
            let system = system::prompt(directory, instance, &model, profile, &data, initial)?;
            let messages = history::messages(directory, &mut data, turns)?;
            (system, messages, None)
        }
        None => (
            reverie_core::memory::trim_text(&scalar(&model.text_field("persona")?)?).to_owned(),
            Vec::new(),
            Some(
                instance.shared_room_tone() == SharedRoomTone::Social
                    && !coding(records.runtime.as_deref()),
            ),
        ),
    };
    Context {
        identity: scalar(&identity_context(Some(instance)))?,
        role: scalar(instance.role())?,
        system,
        self_model: serde_json::from_slice(&model.as_json())?,
        plan: plan_text(records.plan)?,
        social_room,
        vacation: records
            .lifecycle
            .as_ref()
            .map(|body| body.text_field("mode"))
            .transpose()?
            .is_some_and(|mode| mode.as_python_text_ref() == "vacation"),
        messages,
        limits,
    }
    .render()
    .map_err(Into::into)
}

fn plan_text(value: Option<DocumentBody>) -> Result<String> {
    match value {
        Some(body) => scalar(&body.text().ok_or("invalid plan document")?),
        None => Ok(DEFAULT_PLAN.to_owned()),
    }
}

#[derive(serde::Deserialize)]
struct Runtime {
    directory: PathBuf,
    session_id: String,
}

#[derive(serde::Deserialize)]
struct Interaction {
    mode: String,
}

fn coding(raw: Option<&str>) -> bool {
    let Some(runtime) = raw.and_then(|text| serde_json::from_str::<Runtime>(text).ok()) else {
        return false;
    };
    let session = runtime.session_id;
    if runtime.directory.as_os_str().is_empty()
        || session.is_empty()
        || session.len() > 160
        || !session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return false;
    }
    let path = runtime
        .directory
        .join(".opencode/interaction-state")
        .join(format!("{session}.json"));
    read_text(&path)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<Interaction>(&text).ok())
        .is_some_and(|state| state.mode == "coding")
}

fn scalar(text: &MetadataText) -> Result<String> {
    text.scalar_text()
        .ok_or_else(|| "invalid continuity text".into())
}

fn env_number<T: std::str::FromStr>(name: &str, default: T) -> T {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn read_text(path: &Path) -> io::Result<Option<String>> {
    const TEXT_BOUND: u64 = 8 * 1024 * 1024;
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(nix::fcntl::OFlag::O_NONBLOCK.bits())
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("expected a regular continuity file"));
    }
    let mut text = String::new();
    file.take(TEXT_BOUND + 1).read_to_string(&mut text)?;
    if text.len() as u64 > TEXT_BOUND {
        return Err(io::Error::other("continuity file is too large"));
    }
    Ok(Some(text.replace("\r\n", "\n").replace('\r', "\n")))
}
