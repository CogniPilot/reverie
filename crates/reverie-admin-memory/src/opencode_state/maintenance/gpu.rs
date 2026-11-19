//! Use the existing maintenance and GPU coordination files in this namespace.
use super::{Result, now};
use crate::capture::{self, Limits};
use nix::{
    errno::Errno,
    fcntl::{Flock, FlockArg},
};
use reverie_core::memory_configuration::TextSetting;
use reverie_host::{
    embeddings::model_api::Route,
    memory_configuration::{MemoryConfiguration, MemoryPath},
};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

pub(super) fn try_lock(path: &Path) -> Result<Option<Flock<File>>> {
    let opened = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    if !opened.metadata()?.is_file() {
        return Err("maintenance lock must be a regular file".into());
    }
    match Flock::lock(opened, FlockArg::LockExclusiveNonblock) {
        Ok(held) => Ok(Some(held)),
        Err((_, Errno::EWOULDBLOCK)) => Ok(None),
        Err((_, error)) => Err(error.into()),
    }
}

pub(super) fn busy(config: &MemoryConfiguration) -> bool {
    for entry in [MemoryPath::Hold, MemoryPath::LegacyHold] {
        if config
            .native_path(entry)
            .and_then(|path| path.try_exists())
            .unwrap_or(true)
        {
            return true;
        }
    }
    let mut command = Command::new("reverie");
    command.args(["agent", "ls"]);
    let Ok(report) = capture_text(command, 20) else {
        return true;
    };
    report.trim().is_empty()
        || report.contains("ECONNREFUSED")
        || report
            .lines()
            .any(|line| line.contains("review-gpu") && line.contains("busy"))
}

pub(super) fn vacation_available(config: &MemoryConfiguration) -> bool {
    let mut command = Command::new("nvidia-smi");
    command.args([
        "--query-gpu=utilization.gpu",
        "--format=csv,noheader,nounits",
    ]);
    let Ok(report) = capture_text(command, 5) else {
        return false;
    };
    !report.trim().is_empty()
        && report
            .lines()
            .all(|line| line.trim().parse::<u8>().is_ok_and(|value| value <= 5))
        && no_other_resident_model(config)
}

fn capture_text(command: Command, seconds: u64) -> Result<String> {
    let limit = Limits::scoped(Instant::now() + Duration::from_secs(seconds), 1024 * 1024);
    Ok(String::from_utf8(capture::run(command, None, limit)?)?)
}

fn no_other_resident_model(config: &MemoryConfiguration) -> bool {
    let scalar = |key| config.settings().text(key).as_text_ref().scalar_text();
    let (Some(base), Some(model)) = (scalar(TextSetting::ApiBase), scalar(TextSetting::Model))
    else {
        return false;
    };
    let base = base.trim_end_matches('/');
    let root = base.strip_suffix("/v1").unwrap_or(base);
    let Ok(bytes) =
        crate::model_completion::request(root, Route::Models, None, Duration::from_secs(5), None)
    else {
        return false;
    };
    let Ok(status) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    status["data"].as_array().is_some_and(|models| {
        !models.is_empty()
            && models.iter().all(|item| {
                item["id"].as_str().is_some_and(|id| id == model)
                    || item["status"]["value"] == "unloaded"
            })
    })
}

pub(super) struct Gpu {
    lock: Flock<File>,
    activity: PathBuf,
    role: &'static str,
}

impl Gpu {
    pub(super) fn acquire(
        config: &MemoryConfiguration,
        role: &'static str,
    ) -> Result<Option<Self>> {
        let path = config.native_path(MemoryPath::GpuLock)?;
        if let Some(parent) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
            fs::create_dir_all(parent)?;
        }
        let Some(mut lock) = try_lock(&path)? else {
            return Ok(None);
        };
        let activity = config.native_path(MemoryPath::GpuActivity)?;
        lock.set_len(0)?;
        serde_json::to_writer(
            &mut *lock,
            &json!({"role": role, "pid":std::process::id(), "since":now()?}),
        )?;
        save_activity(&activity, role)?;
        Ok(Some(Self {
            lock,
            activity,
            role,
        }))
    }

    pub(super) fn finish(self) -> Result<()> {
        self.lock.set_len(0)?;
        save_activity(&self.activity, self.role)
    }
}

fn save_activity(path: &Path, role: &str) -> Result<()> {
    let parent = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let (file, temporary) = nix::unistd::mkstemp(&parent.join(".gpu-activity-XXXXXX"))?;
    let mut file = File::from(file);
    let result = (|| -> Result<()> {
        serde_json::to_writer(&mut file, &json!({"role":role, "at":now()?}))?;
        file.flush()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        match fs::remove_file(&temporary) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    result
}
