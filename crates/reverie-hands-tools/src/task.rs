use crate::protocol::Result;
use nix::libc;
use serde::Deserialize;
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

const MANIFEST_LIMIT: u64 = 65_536;

#[derive(Deserialize)]
struct Manifest {
    version: u8,
    task_id: String,
    #[serde(default)]
    test_argv: Option<serde_json::Value>,
    #[serde(default)]
    test_timeout_s: Option<serde_json::Value>,
}

pub(crate) struct Task {
    work: PathBuf,
    manifest: Manifest,
}

impl Task {
    pub(crate) fn read(root: &Path, task: &Path) -> Result<Self> {
        if !root.is_absolute() || !task.is_absolute() {
            return Err("absolute task paths required".into());
        }
        if task.parent() != Some(root)
            || fs::canonicalize(root)?.as_os_str() != root.as_os_str()
            || fs::canonicalize(task)?.as_os_str() != task.as_os_str()
        {
            return Err("task must be a direct, nonsymlink child of its configured root".into());
        }
        let manifest = read_manifest(&task.join("manifest.json"))?;
        if manifest.version != 1 || task.file_name() != Some(manifest.task_id.as_ref()) {
            return Err("task manifest identity mismatch".into());
        }
        let work = task.join("work");
        if !work.is_dir() || fs::canonicalize(&work)? != work {
            return Err("workspace must be a real task directory".into());
        }
        Ok(Self { work, manifest })
    }

    pub(crate) fn workspace(&self) -> &Path {
        &self.work
    }

    pub(crate) fn tests(&self) -> Result<Vec<String>> {
        let args = self
            .manifest
            .test_argv
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .filter(|argv| !argv.is_empty())
            .ok_or("this task has no test command")?;
        args.iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "each argv item must be a string".into())
            })
            .collect()
    }

    pub(crate) fn test_timeout(&self, default: u64, maximum: u64) -> Result<u64> {
        let Some(value) = &self.manifest.test_timeout_s else {
            return Ok(default);
        };
        let parsed = match value {
            serde_json::Value::Number(value) => value.as_f64(),
            serde_json::Value::String(value) => value.trim().parse::<i64>().ok().map(|v| v as f64),
            serde_json::Value::Bool(value) => Some(f64::from(u8::from(*value))),
            _ => None,
        };
        parsed
            .filter(|time| time.is_finite())
            .map(|time| (time as u64).min(maximum))
            .ok_or_else(|| "invalid task test timeout".into())
    }
}

fn read_manifest(path: &Path) -> Result<Manifest> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "invalid task manifest")?;
    let info = file.metadata()?;
    if !info.is_file() || info.len() > MANIFEST_LIMIT {
        return Err("invalid task manifest".into());
    }
    let mut bytes = Vec::new();
    file.take(MANIFEST_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MANIFEST_LIMIT {
        return Err("invalid task manifest".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "bad request or manifest".into())
}
