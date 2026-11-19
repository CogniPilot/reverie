//! Explicit maintenance for the same legacy memory selection used by reverie-chat.
use crate::{context_cli, opencode_state::maintenance};
use clap::{Args, Parser};
use reverie_application::memory_startup::StartedMemory;
use reverie_core::{
    memory::{DREAM, EPISODE, REFLECTION, trim_text},
    memory_configuration::{IntegerSetting, TextSetting},
};
use reverie_host::memory_configuration::{MemoryConfiguration, MemoryPath};
use reverie_store::memory::{Memory, MemoryStore, RetrievalOptions};
use serde_json::Value;
use std::{
    env,
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Command, ExitCode},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Parser)]
#[command(
    name = "reverie-chat",
    about = "Run registered Office chat or maintain the selected private memory."
)]
struct Arguments {
    #[arg(long)]
    instance: Option<PathBuf>,
    #[command(flatten)]
    maintenance: Options,
}

#[derive(Args)]
struct Options {
    /// Inspect memory paths, counts, and model reachability.
    #[arg(long)]
    check: bool,
    /// Consolidate one batch of pending episodes.
    #[arg(long)]
    reflect: bool,
    /// Dream once independently of the background schedule.
    #[arg(long)]
    dream: bool,
    /// List saved dream summaries.
    #[arg(long)]
    dreams: bool,
    /// Mark an existing dream as released.
    #[arg(long, value_name = "ID")]
    release_dream: Option<i64>,
    /// List held beliefs.
    #[arg(long)]
    beliefs: bool,
    /// Rate up to 50 pending episodes.
    #[arg(long)]
    rate: bool,
    /// Print the private profile.
    #[arg(long)]
    profile: bool,
    /// Search the selected private memory.
    #[arg(long, value_name = "TEXT")]
    recall: Option<String>,
}

enum Action {
    Check,
    Reflect,
    Dream,
    Dreams,
    Beliefs,
    Rate,
    Profile,
    Release(i64),
    Recall(String),
}

impl Options {
    fn selected(self) -> Option<Action> {
        [
            self.profile.then_some(Action::Profile),
            self.recall.map(Action::Recall),
            self.rate.then_some(Action::Rate),
            self.dream.then_some(Action::Dream),
            self.dreams.then_some(Action::Dreams),
            self.beliefs.then_some(Action::Beliefs),
            self.release_dream.map(Action::Release),
            self.reflect.then_some(Action::Reflect),
            self.check.then_some(Action::Check),
        ]
        .into_iter()
        .flatten()
        .next()
    }
}

pub(super) fn entry() -> ExitCode {
    let args = Arguments::parse();
    match execute(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("reverie-chat: {error}");
            ExitCode::FAILURE
        }
    }
}

fn execute(args: Arguments) -> Result<()> {
    let config = MemoryConfiguration::capture_instance(args.instance.as_deref())?;
    let memory = StartedMemory::initialize(&config, &[])?;
    let Some(action) = args.maintenance.selected() else {
        memory.close()?;
        let mut command = Command::new("reverie-hands");
        command
            .arg("--chat-continuity")
            .arg(config.native_path(MemoryPath::Database)?.canonicalize()?)
            .arg("--no-tui");
        if let Some(instance) = args.instance {
            command.env("REVERIE_INSTANCE_CONFIG", instance);
        }
        return Err(command.exec().into());
    };
    let result = action.run(&config, memory.store());
    let closed = memory.close();
    result?;
    Ok(closed?)
}

impl Action {
    fn run(self, config: &MemoryConfiguration, store: &MemoryStore) -> Result<()> {
        match self {
            Self::Check => check(config, store)?,
            Self::Reflect => {
                for memory in maintenance::reflect_once(config, store)? {
                    println!(
                        "[{}] ({:.0}) {}",
                        memory.section, memory.importance, memory.text
                    );
                }
            }
            Self::Dream => {
                if let Some(memory) = maintenance::dream_once(config, store)? {
                    let dream = DreamView::read(&memory)?;
                    println!("[{}] {}\n-> {}", dream.tone, memory.text, dream.recall);
                } else {
                    println!("no dream");
                }
            }
            Self::Dreams => list_dreams(store)?,
            Self::Beliefs => list_beliefs(store)?,
            Self::Rate => println!("rated {} episodes", maintenance::rate_once(config, store)?),
            Self::Profile => {
                let text = context_cli::read_text(&config.native_path(MemoryPath::Profile)?)?;
                println!("{}", trim_text(text.as_deref().unwrap_or_default()));
            }
            Self::Release(id) => {
                store.release_dream(id, true)?;
                println!("dream #{id} released");
            }
            Self::Recall(query) => recall(config, store, &query)?,
        }
        Ok(())
    }
}

fn check(config: &MemoryConfiguration, store: &MemoryStore) -> Result<()> {
    let episodes = store.count(Some(EPISODE))?;
    let reflections = store.count(Some(REFLECTION))?;
    println!(
        "db:       {} ({episodes} episodes, {reflections} reflections)",
        store.path().display()
    );
    for (label, path) in [
        ("profile", MemoryPath::Profile),
        ("persona", MemoryPath::Persona),
        ("log", MemoryPath::Log),
    ] {
        println!("{label:9} {}", config.native_path(path)?.display());
    }
    let embedder = store
        .embedder_name()?
        .scalar_text()
        .ok_or("invalid embedder name")?;
    println!("embedder: {embedder}");
    println!(
        "session:  {}",
        env::var("REVERIE_SESSION_ID")
            .ok()
            .filter(|id| !id.is_empty())
            .as_deref()
            .unwrap_or("(not inside a Reverie session)")
    );
    let base = config
        .settings()
        .text(TextSetting::ApiBase)
        .as_text_ref()
        .scalar_text()
        .ok_or("invalid model endpoint")?;
    let model = config
        .settings()
        .text(TextSetting::Model)
        .as_text_ref()
        .scalar_text()
        .ok_or("invalid model name")?;
    match maintenance::router_check(config) {
        Some(reply) => println!("router:   ok ({base}, {model}): {reply}"),
        None => println!("router:   unreachable ({base}, {model})"),
    }
    Ok(())
}

fn recall(config: &MemoryConfiguration, store: &MemoryStore, query: &str) -> Result<()> {
    let k = config
        .settings()
        .integer(IntegerSetting::RecallCount)
        .to_i64()
        .ok_or("recall count out of range")?;
    for memory in store.retrieve(
        query,
        RetrievalOptions {
            k,
            ..RetrievalOptions::default()
        },
    )? {
        println!(
            "{:.3} [{} #{} imp {:.0}] {}",
            memory.score,
            memory.kind,
            memory.id,
            memory.importance,
            memory.text.replace('\n', " / ")
        );
    }
    Ok(())
}

struct DreamView {
    recall: String,
    tone: String,
    released: bool,
}

impl DreamView {
    fn read(memory: &Memory) -> Result<Self> {
        let meta: Value = serde_json::from_str(&memory.meta.json())?;
        Ok(Self {
            recall: memory
                .recall()?
                .scalar_text()
                .ok_or("invalid dream recall")?,
            tone: meta["tone"].as_str().unwrap_or("unknown").to_owned(),
            released: meta["released"] == true,
        })
    }
}

fn list_dreams(store: &MemoryStore) -> Result<()> {
    for memory in store.all(Some(DREAM))? {
        let dream = DreamView::read(&memory)?;
        let released = if dream.released { " released" } else { "" };
        println!(
            "#{} [{}{}] from {}: {}",
            memory.id,
            dream.tone,
            released,
            memory.source_ids.json(),
            dream.recall
        );
    }
    Ok(())
}

fn list_beliefs(store: &MemoryStore) -> Result<()> {
    for belief in store.beliefs()? {
        let protected = if belief.protected { ", protected" } else { "" };
        let parent = belief
            .parent_id
            .map(|id| format!(", elaborates #{id}"))
            .unwrap_or_default();
        println!(
            "#{} ({:.0}{protected}{parent}) {}",
            belief.id, belief.weight, belief.text
        );
    }
    Ok(())
}
