//! Standalone and OpenCode continuation use a read-only view of existing state.
mod history;
mod system;
pub(crate) use system::render_beliefs;

use crate::opencode_context::{Context, Limits};
use clap::{Args, Parser, ValueEnum};
use reverie_contracts::{
    memory_documents::DocumentBody,
    memory_instance::{MemoryInstance, identity_context},
    storage_identity::MetadataText,
};
use reverie_core::{
    memory_configuration::IntegerSetting, memory_documents::DEFAULT_PLAN,
    memory_instance::SharedRoomTone,
};
use reverie_host::memory_configuration::{MemoryConfiguration, MemoryPath};
use reverie_store::memory::{Continuity, ContinuityScope, NativeMemoryRead};
use serde::Deserialize;
use std::{
    env,
    fs::OpenOptions,
    io::{self, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::ExitCode,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, Copy, Deserialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
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
    #[command(flatten)]
    context: ContextOptions,
}

#[derive(Args, Deserialize)]
#[serde(default)]
pub(super) struct ContextOptions {
    #[arg(long, value_enum, default_value = "work")]
    channel: Channel,
    #[arg(long, default_value_t = 16_384)]
    context_window: u64,
    #[arg(long, default_value_t = 4096)]
    output_tokens: u64,
    #[arg(long, default_value_t = 0)]
    occupied_tokens: u64,
}

impl Default for ContextOptions {
    fn default() -> Self {
        Self {
            channel: Channel::Private,
            context_window: 16_384,
            output_tokens: 4096,
            occupied_tokens: 0,
        }
    }
}

pub(super) fn entry() -> ExitCode {
    use clap::CommandFactory;
    let arguments = Arguments::parse();
    if arguments.instance.is_none()
        && env::var_os("REVERIE_INSTANCE_CONFIG").is_none_or(|value| value.is_empty())
    {
        Arguments::command()
            .error(
                clap::error::ErrorKind::MissingRequiredArgument,
                "select an explicit external instance",
            )
            .exit();
    }
    match MemoryConfiguration::capture_instance(arguments.instance.as_deref())
        .map_err(Into::into)
        .and_then(|configuration| arguments.context.render(&configuration))
        .and_then(|text| writeln!(io::stdout().lock(), "{text}").map_err(Into::into))
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("reverie-context: {error}");
            ExitCode::FAILURE
        }
    }
}

impl ContextOptions {
    pub(super) fn render(self, config: &MemoryConfiguration) -> Result<String> {
        let limits = Limits {
            window: self.context_window,
            output: self.output_tokens,
            occupied: self.occupied_tokens,
        };
        if !(1024..=10_000_000).contains(&limits.window) {
            return Err("unsupported context window".into());
        }
        let profile = match self.channel {
            Channel::Work => None,
            Channel::Private => read_text(&config.native_path(MemoryPath::Profile)?)?,
        };
        let turns = config
            .settings()
            .integer(IntegerSetting::ShortTermTurns)
            .to_i64()
            .unwrap_or(i64::MAX);
        let scope = match self.channel {
            Channel::Work => ContinuityScope::Shared,
            Channel::Private => ContinuityScope::Private {
                turns,
                derive_profile: profile.is_none(),
            },
        };
        let records =
            NativeMemoryRead::read_continuity(&config.native_path(MemoryPath::Database)?, scope)?;
        render(config, records, profile, turns, limits)
    }
}

fn render(
    config: &MemoryConfiguration,
    records: Continuity,
    profile: Option<String>,
    turns: i64,
    limits: Limits,
) -> Result<String> {
    let instance = config.instance().map(|loaded| loaded.configuration());
    let initial = records.self_model.is_none();
    let model = match records.self_model {
        Some(model) => model,
        None => instance.map_or_else(
            || Ok(DocumentBody::initial_self()),
            MemoryInstance::initial_model,
        )?,
    };
    let (system, messages, social_room) = match records.private {
        Some(mut data) => {
            let system = system::prompt(config, instance, &model, profile, &data, initial)?;
            let messages = history::messages(config, &mut data, turns)?;
            (system, messages, None)
        }
        None => (
            reverie_core::memory::trim_text(&scalar(&model.text_field("persona")?)?).to_owned(),
            Vec::new(),
            Some(
                instance
                    .is_some_and(|instance| instance.shared_room_tone() == SharedRoomTone::Social)
                    && !coding(records.runtime.as_deref()),
            ),
        ),
    };
    Context {
        identity: scalar(&identity_context(instance))?,
        role: instance.map_or_else(
            || Ok("Expert".to_owned()),
            |instance| scalar(instance.role()),
        )?,
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
