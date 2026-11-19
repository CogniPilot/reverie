//! Prepare the Hands runtime configuration before exec.
mod files;
mod profile;
mod settings;

use crate::office::{self, FetchError};
use nix::{
    sys::stat::{Mode, umask},
    unistd::{User, getuid},
};
use reverie_host::memory_configuration::{MemoryConfiguration, MemoryPath};
use serde_json::{Value, json};
use std::{
    env,
    ffi::{OsStr, OsString},
    io,
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Command, ExitCode},
    thread,
    time::{Duration, Instant},
};

const HELP: &str = "Reverie Admin Harness: local-model chat, authorized workspace tools and an interactive terminal. Type /help; --no-tui uses plain logs. The saved harness identifier remains hands for compatibility.";
const PROFILE_UNAVAILABLE: &str =
    "Registered employee profile is unavailable; retry when the office reconnects";

struct Launch {
    session: String,
    model: String,
    base: String,
    office: String,
    directory: PathBuf,
    chat_continuity: Option<PathBuf>,
}

fn setting(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.is_empty())
}

fn path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn data_directory() -> crate::Result<PathBuf> {
    if let Some(root) = path("REVERIE_DATA_DIR") {
        return Ok(root);
    }
    path("REVERIE_AGENT_HOME")
        .or_else(|| path("HOME"))
        .or_else(|| {
            User::from_uid(getuid())
                .ok()
                .flatten()
                .map(|account| account.dir)
        })
        .map(|home| home.join(".reverie"))
        .ok_or("Hands data directory unavailable")
}

impl Launch {
    fn capture(chat_continuity: Option<PathBuf>) -> crate::Result<Self> {
        let session = setting("REVERIE_SESSION_ID")
            .filter(|id| {
                (8..=100).contains(&id.len())
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            })
            .ok_or("Hands must start in a registered Reverie session")?;
        let (model, base) = model_settings(chat_continuity.is_some())?;
        let directory = data_directory()?.join("hands").join(&session);
        if directory.to_str().is_none() {
            return Err("Hands data directory must be a UTF-8 path");
        }
        Ok(Self {
            session,
            model,
            base: base.trim_end_matches('/').to_owned(),
            office: env::var("REVERIE_API_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".into()),
            directory,
            chat_continuity,
        })
    }

    fn employee(&self) -> crate::Result<Value> {
        let until = Instant::now() + Duration::from_secs(15);
        while Instant::now() < until {
            let seconds = until
                .saturating_duration_since(Instant::now())
                .as_secs_f64()
                .clamp(0.001, 3.0);
            if let Some(employee) = self.profile_attempt(&format!("{seconds:.3}"))? {
                return Ok(employee);
            }
            thread::sleep(
                until
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(200)),
            );
        }
        Err(PROFILE_UNAVAILABLE)
    }

    fn profile_attempt(&self, timeout: &str) -> crate::Result<Option<Value>> {
        match office::company(&self.office, &self.session, timeout) {
            Ok(body) => profile::for_session(body, &self.session),
            Err(FetchError::Transport | FetchError::Http(502..=504)) => Ok(None),
            Err(error) => Err(error.message()),
        }
    }

    fn prepare(self) -> crate::Result<PathBuf> {
        let files = files::Directory::open(&self.directory)
            .map_err(|_| "Private Hands data directory unavailable")?;
        let settings = settings::load(&files)?;
        let employee = self.employee()?;
        let name = employee["name"].as_str().ok_or(PROFILE_UNAVAILABLE)?;
        let mut config = self.configuration(name, settings);
        files
            .publish(
                "profile.txt",
                profile::render(name, &employee).as_bytes(),
                false,
            )
            .map_err(file_error)?;
        let memory =
            self.configuration_memory(&files, name, profile::persona(&employee).unwrap_or(name))?;
        if let Some(memory) = memory {
            config["memory_instance"] = json!(memory);
        }
        let bytes = serde_json::to_vec_pretty(&config)
            .map_err(|_| "Could not encode Hands configuration")?;
        let file = if self.chat_continuity.is_some() {
            "chat-continuity.json"
        } else {
            "agent.json"
        };
        files.publish(file, &bytes, false).map_err(file_error)?;
        Ok(self.directory.join(file))
    }

    fn configuration_memory(
        &self,
        files: &files::Directory,
        name: &str,
        persona: &str,
    ) -> crate::Result<Option<PathBuf>> {
        let Some(expected) = &self.chat_continuity else {
            let memory = self.memory_document(name, persona, std::path::Path::new("memory-state"));
            publish_memory(files, "memory-instance.json", &memory, true)?;
            return Ok(None);
        };
        let config =
            MemoryConfiguration::capture().map_err(|_| "Invalid legacy chat memory selection")?;
        let database = config
            .native_path(MemoryPath::Database)
            .and_then(std::fs::canonicalize)
            .map_err(|_| "Legacy chat database unavailable")?;
        if &database != expected {
            return Err("Legacy chat memory selection changed during startup");
        }
        if let Some(instance) = config.instance() {
            let absolute: String = instance
                .configuration_path()
                .codepoints()
                .into_iter()
                .map(char::from_u32)
                .collect::<Option<_>>()
                .ok_or("Hands memory selection must be a UTF-8 path")?;
            return Ok(Some(absolute.into()));
        }
        let data = config
            .native_path(MemoryPath::Data)
            .and_then(std::fs::canonicalize)
            .map_err(|_| "Legacy chat data directory unavailable")?;
        let directory = config
            .native_path(MemoryPath::Cache)
            .map_err(|_| "Legacy chat configuration directory unavailable")?
            .join("chat-continuity")
            .join(&self.session);
        if directory.starts_with(&data) {
            return Err(
                "Select --instance with a configuration outside the legacy chat data directory",
            );
        }
        let cache = files::Directory::open(&directory).map_err(file_error)?;
        let file = "memory-instance.json";
        publish_memory(
            &cache,
            file,
            &self.memory_document(name, persona, &data),
            false,
        )?;
        Ok(Some(directory.join(file)))
    }

    fn memory_document(&self, name: &str, persona: &str, data: &std::path::Path) -> Value {
        json!({
            "id": self.session, "agent_name": name, "owner_name": "Company owner",
            "data_dir": data, "persona": persona,
        })
    }

    fn configuration(&self, name: &str, overrides: serde_json::Map<String, Value>) -> Value {
        let key_env = (self.chat_continuity.is_none()
            || setting("REVERIE_HANDS_API_KEY").is_some())
        .then_some("REVERIE_HANDS_API_KEY");
        let mut config = json!({
            "rooms": "auto", "self_session_id": self.session, "self_name": name,
            "state_file": self.directory.join("state.json"), "api_base": self.base, "model": self.model,
            "model_key_env": key_env, "cli": ["reverie", "agent", "chat"],
            "identity_file": self.directory.join("profile.txt"), "memory_file": null,
            "memory_instance": self.directory.join("memory-instance.json"),
            "poll_s": 15, "phone_wake": true, "prompt_cap_chars": 60000, "reply_max_tokens": 4096,
            "timezone": "UTC", "vision": false, "search": false, "web_fetch": false, "coding": null,
            "managed_context": true, "attachments_root": "/reverie_workspace/attachments",
            "image_tokens_per_image": 2048, "model_events_file": self.directory.join("model-events.jsonl"),
            "web_log": self.directory.join("web.jsonl"),
        });
        config
            .as_object_mut()
            .expect("configuration is an object")
            .extend(overrides);
        config
    }
}

fn file_error(_: io::Error) -> &'static str {
    "Could not publish private Hands configuration"
}

fn publish_memory(
    files: &files::Directory,
    file: &str,
    memory: &Value,
    once: bool,
) -> crate::Result<()> {
    let bytes =
        serde_json::to_vec(memory).map_err(|_| "Could not encode Hands memory configuration")?;
    files.publish(file, &bytes, once).map_err(file_error)
}

fn model_settings(chat_continuity: bool) -> crate::Result<(String, String)> {
    if chat_continuity {
        let model = setting("REVERIE_MODEL")
            .or_else(|| setting("REVERIE_HANDS_MODEL"))
            .unwrap_or_else(|| "MODEL_ID".into());
        let base = setting("REVERIE_API_BASE")
            .or_else(|| setting("REVERIE_HANDS_BASE_URL"))
            .unwrap_or_else(|| "http://127.0.0.1:8080/v1".into());
        return Ok((model, base));
    }
    setting("REVERIE_HANDS_MODEL")
        .zip(setting("REVERIE_HANDS_BASE_URL"))
        .ok_or("Choose a local model endpoint for this Hands session")
}

fn launch(
    mut command: Command,
    flags: &[OsString],
    chat_continuity: Option<PathBuf>,
) -> crate::Result<()> {
    umask(Mode::S_IRWXG | Mode::S_IRWXO);
    let path = Launch::capture(chat_continuity)?.prepare()?;
    let _ = command.arg(path).args(flags).exec();
    Err("Could not start the Hands runtime")
}

fn native(runtime: &OsStr, flags: &[OsString]) -> crate::Result<()> {
    let mut command = Command::new(runtime);
    command.arg("--hands-native");
    if let Some(rest) = flags.strip_prefix(&[OsString::from("--chat-continuity")]) {
        let (database, flags) = rest
            .split_first()
            .ok_or("Legacy chat database is required")?;
        return launch(command, flags, Some(database.into()));
    }
    launch(command, flags, None)
}

pub(super) fn entry(args: Vec<OsString>) -> ExitCode {
    let result = match args.as_slice() {
        [_, _, flags @ ..] if flags.iter().any(|flag| flag == "--help") => {
            println!("{HELP}");
            return ExitCode::SUCCESS;
        }
        [option, runtime, flags @ ..] if option == "--native-runtime" => native(runtime, flags),
        _ => Err("Hands native runtime executable is required"),
    };
    if let Err(error) = result {
        eprintln!("Reverie Admin Harness could not start: {error}");
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
