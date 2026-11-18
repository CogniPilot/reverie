mod capture;

use crate::{
    Options,
    protocol::{self, Reply, Result},
    task::Task,
    telemetry,
};
use nix::sys::resource::{Resource, setrlimit};
use reverie_core::ids::ProfileSessionId;
use serde::Deserialize;
use std::{
    env,
    ffi::{OsStr, OsString},
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

const OFFICE_ENV: [&str; 5] = [
    "REVERIE_MUX",
    "REVERIE_SESSION_ID",
    "REVERIE_API_URL",
    "REVERIE_AGENT_HOME",
    "REVERIE_DATA_DIR",
];

pub(crate) struct Settings {
    path: OsString,
    office: Vec<(&'static str, OsString)>,
    max_seconds: u64,
    telemetry: bool,
}

impl Settings {
    pub(crate) fn new(options: &Options) -> Result<Self> {
        let defaults = option_env!("REVERIE_HANDS_TOOL_PATH").unwrap_or("/bin");
        let path = env::join_paths([
            options
                .tool_path
                .clone()
                .unwrap_or_else(|| PathBuf::from(defaults)),
            "/home/agent/.nix-profile/bin".into(),
            "/home/agent/.local/bin".into(),
            "/bin".into(),
        ])
        .map_err(|_| "invalid laptop tool path")?;
        let office = if env::var_os("REVERIE_SCOPED_OFFICE").as_deref() == Some(OsStr::new("1")) {
            scoped_office()?
        } else {
            Vec::new()
        };
        Ok(Self {
            path,
            office,
            max_seconds: u64::try_from(options.timeout_s).map_err(|_| "invalid runner budget")?,
            telemetry: options.command_telemetry,
        })
    }

    pub(crate) fn apply_resource_limits(&self) -> Result<()> {
        const MAX_FILE: u64 = 512 * 1024 * 1024;
        setrlimit(Resource::RLIMIT_CORE, 0, 0).map_err(|error| error.to_string())?;
        setrlimit(Resource::RLIMIT_FSIZE, MAX_FILE, MAX_FILE).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn default_seconds(&self) -> u64 {
        self.max_seconds.min(30)
    }

    fn command(&self, workspace: &Path, argv: &[String]) -> Command {
        let mut command = Command::new(&argv[0]);
        command
            .args(&argv[1..])
            .current_dir(workspace)
            .env_clear()
            .env("PATH", &self.path)
            .env("HOME", workspace)
            .env("TMPDIR", "/tmp")
            .env("TMP", "/tmp")
            .env("TEMP", "/tmp")
            .env("LANG", "C.UTF-8")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .envs(self.office.iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }
}

fn scoped_office() -> Result<Vec<(&'static str, OsString)>> {
    let url = env::var("REVERIE_API_URL").unwrap_or_default();
    let session = env::var("REVERIE_SESSION_ID").unwrap_or_default();
    if relay_port(&url).is_none() || ProfileSessionId::parse(&session).is_err() {
        return Err("Invalid scoped office relay".into());
    }
    Ok(OFFICE_ENV
        .into_iter()
        .filter_map(|name| env::var_os(name).map(|value| (name, value)))
        .collect())
}

fn relay_port(url: &str) -> Option<u16> {
    let (scheme, address) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") {
        return None;
    }
    let port = address.strip_prefix("127.0.0.1:")?;
    let port = port.strip_suffix('/').unwrap_or(port);
    if !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse().ok().filter(|port| *port != 0)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Run {
    argv: Vec<String>,
    timeout_s: Option<usize>,
}

pub(crate) fn run(task: &Task, settings: &Settings, args: Run, limit: usize) -> Result<Reply> {
    let seconds = protocol::bounded_integer(
        args.timeout_s,
        "timeout_s",
        settings.default_seconds() as usize,
        settings.max_seconds as usize,
    )?;
    execute(task, settings, &args.argv, seconds as u64, limit)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Tests {
    select: Option<Vec<String>>,
}

pub(crate) fn test(task: &Task, settings: &Settings, args: Tests, limit: usize) -> Result<Reply> {
    let mut argv = task.tests()?;
    let selectors = args.select.unwrap_or_default();
    if selectors.len() > 20 {
        return Err("at most 20 selectors".into());
    }
    if selectors.iter().any(|selector| {
        selector.is_empty()
            || selector.starts_with('-')
            || selector.contains('\0')
            || selector.chars().count() > 200
    }) {
        return Err(
            "each selector must be a test path or id of at most 200 chars, not an option".into(),
        );
    }
    argv.extend(selectors);
    let seconds = task.test_timeout(settings.default_seconds(), settings.max_seconds)?;
    execute(task, settings, &argv, seconds, limit)
}

fn check_argv(argv: &[String]) -> Result<()> {
    if !(1..=64).contains(&argv.len()) {
        return Err("argv must be an array of 1 to 64 strings".into());
    }
    if argv
        .iter()
        .any(|arg| arg.chars().count() > 4_000 || arg.contains('\0'))
    {
        return Err("each argv item must be a string of at most 4000 chars without NUL".into());
    }
    if argv[0].is_empty() {
        return Err("argv[0] must not be empty".into());
    }
    Ok(())
}

fn execute(
    task: &Task,
    settings: &Settings,
    argv: &[String],
    seconds: u64,
    limit: usize,
) -> Result<Reply> {
    check_argv(argv)?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(execute_bound(task, settings, argv, seconds, limit))
}

async fn execute_bound(
    task: &Task,
    settings: &Settings,
    argv: &[String],
    seconds: u64,
    limit: usize,
) -> Result<Reply> {
    let child = match settings.command(task.workspace(), argv).spawn() {
        Ok(child) => child,
        Err(error) => {
            let code = if error.kind() == ErrorKind::NotFound {
                127
            } else {
                126
            };
            telemetry::observe(settings.telemetry, &argv[0], code);
            return Err(format!("could not start {:?}: {error}", argv[0]).into());
        }
    };
    let observed = capture::observe(child, Duration::from_secs(seconds), limit).await?;
    telemetry::observe(settings.telemetry, &argv[0], observed.exit);
    Ok(observed.reply(seconds))
}
