use super::MIB;
use nix::{
    errno::Errno,
    fcntl::{Flock, FlockArg},
};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path},
};

const ESTIMATE_FLOOR: u64 = 256 * MIB;

pub(super) fn estimate(path: &Path, project: &str, command: &[String], jobs: u8) -> Option<u64> {
    let file = File::open(path).ok()?;
    let command = json!(command);
    let mut same_jobs = None;
    let mut fewer_jobs = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if entry["project"] != project || entry["status"] != "ok" || entry["command"] != command {
            continue;
        }
        let Some(peak) = entry["peak_mib"].as_f64().filter(|peak| peak.is_finite()) else {
            continue;
        };
        let measured = &entry["jobs"];
        if measured.as_f64() == Some(f64::from(jobs)) {
            retain_maximum(&mut same_jobs, peak);
        } else if let Some(fewer) = measured
            .as_u64()
            .filter(|fewer| *fewer > 0 && *fewer < u64::from(jobs))
        {
            retain_maximum(&mut fewer_jobs, peak * f64::from(jobs) / fewer as f64);
        }
    }
    let peak = same_jobs.or(fewer_jobs)?;
    Some(((peak * 1.25 * MIB as f64) as u64).max(ESTIMATE_FLOOR))
}

fn retain_maximum(maximum: &mut Option<f64>, value: f64) {
    *maximum = Some(maximum.map_or(value, |previous| previous.max(value)));
}

fn append_file(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "build record or lock must be a regular file",
        ));
    }
    Ok(file)
}

pub(super) fn lock_target(target: &Path) -> io::Result<Option<Flock<File>>> {
    fs::create_dir_all(target)?;
    let file = append_file(&target.join(".build.lock"))?;
    match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(lock) => Ok(Some(lock)),
        Err((_, Errno::EWOULDBLOCK)) => Ok(None),
        Err((_, error)) => Err(error.into()),
    }
}

pub(super) fn scratch_directory(root: &Path, relative: &Path) -> io::Result<()> {
    let mut path = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid scratch path",
            ));
        };
        path.push(name);
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        if !fs::symlink_metadata(&path)?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("scratch path must be a real directory: {}", path.display()),
            ));
        }
    }
    Ok(())
}

pub(super) fn append(path: &Path, record: &Value) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = append_file(path)?;
    let mut held =
        Flock::lock(file, FlockArg::LockExclusive).map_err(|(_, error)| io::Error::from(error))?;
    let mut line = serde_json::to_vec(record)?;
    line.push(b'\n');
    held.write_all(&line)
}
