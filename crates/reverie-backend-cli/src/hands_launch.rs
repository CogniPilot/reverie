//! Select and publish the legacy Hands runtime configuration before exec.
mod files;
mod profile;
mod settings;

use crate::office::{self, FetchError};
use nix::{
    sys::stat::{Mode, umask},
    unistd::{User, getuid},
};
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
    fn capture() -> crate::Result<Self> {
        let session = setting("REVERIE_SESSION_ID")
            .filter(|id| {
                (8..=100).contains(&id.len())
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            })
            .ok_or("Hands must start in a registered Reverie session")?;
        let [Some(model), Some(base)] = [
            setting("REVERIE_HANDS_MODEL"),
            setting("REVERIE_HANDS_BASE_URL"),
        ] else {
            return Err("Choose a local model endpoint for this Hands session");
        };
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
        let config = self.configuration(name, settings);
        files
            .publish(
                "profile.txt",
                profile::render(name, &employee).as_bytes(),
                false,
            )
            .map_err(file_error)?;
        let memory = json!({
            "id": self.session,
            "agent_name": name,
            "owner_name": "Company owner",
            "data_dir": "memory-state",
            "persona": profile::persona(&employee).unwrap_or(name),
        });
        files
            .publish(
                "memory-instance.json",
                &serde_json::to_vec(&memory)
                    .map_err(|_| "Could not encode Hands memory configuration")?,
                true,
            )
            .map_err(file_error)?;
        let bytes = serde_json::to_vec_pretty(&config)
            .map_err(|_| "Could not encode Hands configuration")?;
        files
            .publish("agent.json", &bytes, false)
            .map_err(file_error)?;
        Ok(self.directory.join("agent.json"))
    }

    fn configuration(&self, name: &str, overrides: serde_json::Map<String, Value>) -> Value {
        let mut config = json!({
            "rooms": "auto", "self_session_id": self.session, "self_name": name,
            "state_file": self.directory.join("state.json"), "api_base": self.base, "model": self.model,
            "model_key_env": "REVERIE_HANDS_API_KEY", "cli": ["reverie", "agent", "chat"],
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

fn launch(runtime: &OsStr, loop_path: &OsStr, flags: &[OsString]) -> crate::Result<()> {
    umask(Mode::S_IRWXG | Mode::S_IRWXO);
    let config = Launch::capture()?.prepare()?;
    let _ = Command::new(runtime)
        .args(["-I", "-B"])
        .arg(loop_path)
        .arg(config)
        .args(flags)
        .exec();
    Err("Could not start the Hands runtime")
}

pub(super) fn entry(args: Vec<OsString>) -> ExitCode {
    let result = match args.as_slice() {
        [_, _, flags @ ..] if flags.iter().any(|flag| flag == "--help") => {
            println!("{HELP}");
            return ExitCode::SUCCESS;
        }
        [runtime, loop_path, flags @ ..] => launch(runtime, loop_path, flags),
        _ => Err("Hands runtime executable and entry point are required"),
    };
    if let Err(error) = result {
        eprintln!("Reverie Admin Harness could not start: {error}");
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
