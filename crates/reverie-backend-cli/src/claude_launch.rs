//! Select a transcript using only metadata in the selected provider account.
mod metadata;

use serde::Deserialize;
use std::{
    env,
    ffi::OsStr,
    io,
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Command, ExitCode},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Debug)]
struct Unavailable;
type Result<T> = std::result::Result<T, Unavailable>;
const SELECTION_BUDGET: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    resumes: Vec<Resume>,
    fresh: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resume {
    id: String,
    command: String,
}

impl Plan {
    fn select(self) -> Result<Vec<String>> {
        let ids: Vec<_> = self.resumes.iter().map(|item| item.id.clone()).collect();
        if ids.len() > 3 || !ids.iter().all(|id| safe_id(id)) {
            return Err(Unavailable);
        }
        let selected = within(SELECTION_BUDGET, move || {
            metadata::select(&config_dir()?, &ids)
        })??;
        let command =
            selected.map_or_else(|| self.fresh, |index| self.resumes[index].command.clone());
        shlex::split(&command)
            .filter(|argv| argv.first().is_some_and(|name| !name.is_empty()))
            .ok_or(Unavailable)
    }
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn config_dir() -> Result<PathBuf> {
    let setting = |key| env::var_os(key).filter(|value| !value.is_empty());
    let config = setting("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| setting("HOME").map(|home| PathBuf::from(home).join(".claude")))
        .ok_or(Unavailable)?;
    std::path::absolute(config).map_err(|_| Unavailable)
}

fn within<T: Send + 'static>(
    budget: Duration,
    observe: impl FnOnce() -> T + Send + 'static,
) -> Result<T> {
    let deadline = Instant::now() + budget;
    let (tx, rx) = mpsc::channel();
    let observation = thread::Builder::new()
        .spawn(move || {
            let _ = tx.send(observe());
        })
        .map_err(|_| Unavailable)?;
    // On expiry this CLI exits, including a thread blocked in ordinary I/O.
    // The provider only starts after the observer exits. No process alarm is armed.
    let result = rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| Unavailable)?;
    observation.join().map_err(|_| Unavailable)?;
    if Instant::now() >= deadline {
        return Err(Unavailable);
    }
    Ok(result)
}

pub(crate) fn entry(plan: Option<&OsStr>) -> ExitCode {
    let argv = plan
        .and_then(OsStr::to_str)
        .and_then(|raw| serde_json::from_str::<Plan>(raw).ok())
        .and_then(|plan| plan.select().ok());
    let Some((executable, args)) = argv.as_deref().and_then(<[String]>::split_first) else {
        eprintln!("Reverie: Claude transcript metadata unavailable; launch withheld.");
        return ExitCode::from(78);
    };
    let error = Command::new(executable).args(args).exec();
    if error.kind() == io::ErrorKind::NotFound {
        eprintln!("Reverie: selected Claude executable unavailable.");
        ExitCode::from(127)
    } else {
        eprintln!("Reverie: selected Claude executable could not start.");
        ExitCode::from(126)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_refuses_a_stalled_observer() {
        let start = Instant::now();
        let result = within(Duration::from_millis(20), || {
            thread::sleep(Duration::from_millis(300));
            Some(0)
        });
        assert!(result.is_err());
        assert!(start.elapsed() < Duration::from_millis(300));
    }

    #[test]
    fn only_completed_in_budget_observations_are_usable() {
        assert_eq!(within(SELECTION_BUDGET, || Some(2)).unwrap(), Some(2));
        assert!(within(Duration::ZERO, || None::<usize>).is_err());
    }
}
