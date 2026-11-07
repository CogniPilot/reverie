//! The GPU and drive readings: a bounded `nvidia-smi` run with one deadline,
//! the sysfs fallback and `statvfs`.
use super::io::{errno_of, os_class, read_small};
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::{AccessFlags, Pid, access};
use reverie_contracts::collector::{
    Config, Gpu, GpuDevice, Out, nvidia_devices, python_float, python_int,
};
use std::io::Read;
use std::os::fd::AsFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Kill the child's whole process group and reap it within five seconds.
fn kill(child: &mut Child) {
    if let Ok(pid) = i32::try_from(child.id()) {
        let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
    }
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// `run_capped(argv, limit, timeout)`: stdout of at most `limit` bytes
/// within one deadline covering both reading and exit; `None` on timeout,
/// oversize, a nonzero exit or any error. stderr is discarded.
fn run_capped(program: &Path, args: &[&str], limit: i64, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let output = read_until(&mut child, deadline, limit);
    let result = output.and_then(|data| {
        // p.wait(timeout=max(left, 0.001)): at least one check after the deadline.
        let end = deadline.max(Instant::now() + Duration::from_millis(1));
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return status
                        .success()
                        .then(|| String::from_utf8_lossy(&data).into_owned());
                }
                Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(1)),
                _ => return None,
            }
        }
    });
    if result.is_none() || matches!(child.try_wait(), Ok(None)) {
        kill(&mut child);
    }
    result
}

fn read_until(child: &mut Child, deadline: Instant, limit: i64) -> Option<Vec<u8>> {
    let mut stdout = child.stdout.take()?;
    let bound = usize::try_from(limit).unwrap_or(0);
    let mut data = Vec::new();
    let mut buffer = [0u8; 65536];
    loop {
        let left = deadline.checked_duration_since(Instant::now())?;
        let millis = u16::try_from(left.as_millis().clamp(1, 60_000)).unwrap_or(u16::MAX);
        let mut fds = [PollFd::new(stdout.as_fd(), PollFlags::POLLIN)];
        if poll(&mut fds, PollTimeout::from(millis)).ok()? == 0 {
            continue;
        }
        let count = stdout.read(&mut buffer).ok()?;
        if count == 0 {
            return Some(data);
        }
        data.extend_from_slice(&buffer[..count]);
        if data.len() > bound {
            return None;
        }
    }
}

fn executable(path: &Path) -> bool {
    path.exists() && access(path, AccessFlags::X_OK).is_ok() && !path.is_dir()
}

/// `shutil.which(name)` on POSIX.
fn which(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        return executable(Path::new(name)).then(|| PathBuf::from(name));
    }
    let search = std::env::var_os("PATH").unwrap_or_else(|| "/bin:/usr/bin".into());
    if search.is_empty() {
        return None;
    }
    std::env::split_paths(&search)
        .map(|directory| directory.join(name))
        .find(|candidate| executable(candidate))
}

const QUERY: [&str; 2] = [
    "--query-gpu=index,utilization.gpu,memory.used,memory.total,uuid",
    "--format=csv,noheader,nounits",
];

/// `gpus(cfg)`; `Err` is the class name of an exception that escapes it.
pub(crate) fn gpus(cfg: &Config) -> Result<Gpu, &'static str> {
    if !cfg.gpu_auto {
        return Ok(Gpu::Off);
    }
    if let Some(program) = which(&cfg.nvidia_smi)
        && let Some(output) = run_capped(
            &program,
            &QUERY,
            cfg.max_input_bytes,
            Duration::from_secs(10),
        )
        && let Some(devices) = nvidia_devices(&output)
    {
        return Ok(Gpu::Devices {
            source: "nvidia-smi",
            devices,
        });
    }
    let drm = Path::new(&cfg.sys_root).join("class").join("drm");
    let mut cards = Vec::new();
    if drm.is_dir() {
        let entries = std::fs::read_dir(&drm).map_err(|error| os_class(errno_of(&error)))?;
        for entry in entries {
            let entry = entry.map_err(|error| os_class(errno_of(&error)))?;
            cards.push(entry.file_name());
        }
    }
    cards.sort();
    let mut devices = Vec::new();
    for card in cards.iter().take(64) {
        let Some(name) = card.to_str() else {
            continue;
        };
        let Some(index) = name
            .strip_prefix("card")
            .filter(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(python_int)
        else {
            continue;
        };
        let busy = drm.join(card).join("device").join("gpu_busy_percent");
        if !busy.is_file() {
            continue;
        }
        if let Ok(text) = read_small(&busy, 64)
            && let Some(util) = python_float(&text)
            && util.is_finite()
            && (0.0..=100.0).contains(&util)
        {
            devices.push(GpuDevice {
                index,
                util_pct: util,
                memory: None,
                uuid: None,
                identity_status: "unavailable",
            });
        }
    }
    Ok(if devices.is_empty() {
        Gpu::None
    } else {
        Gpu::Devices {
            source: "sysfs",
            devices,
        }
    })
}

/// `drive(path)`: usage from `statvfs`, or `{"status": "error", "error": class}`.
#[allow(clippy::cast_precision_loss)]
pub(crate) fn drive(path: &str) -> Out {
    let info = match nix::sys::statvfs::statvfs(path) {
        Ok(info) => info,
        Err(errno) => {
            return Out::map([
                ("status", Out::text("error")),
                ("error", Out::text(os_class(errno))),
            ]);
        }
    };
    let fragment = i128::from(info.fragment_size());
    let blocks = i128::from(info.blocks());
    let used = (blocks - i128::from(info.blocks_free())) * fragment;
    let available = i128::from(info.blocks_available()) * fragment;
    let denominator = used + available;
    let percent = if denominator == 0 {
        Out::Null
    } else {
        Out::Float(reverie_contracts::collector::round2(
            100.0 * used as f64 / denominator as f64,
        ))
    };
    Out::map([
        ("used_pct", percent),
        ("free", Out::int(available)),
        ("total", Out::int(blocks * fragment)),
        ("used", Out::int(used)),
    ])
}

#[cfg(test)]
mod tests {
    use super::run_capped;
    use std::path::Path;
    use std::time::{Duration, Instant};

    fn shell(script: &str, limit: i64, timeout: f64) -> Option<String> {
        run_capped(
            Path::new("sh"),
            &["-c", script],
            limit,
            Duration::from_secs_f64(timeout),
        )
    }

    #[test]
    fn run_capped_deadline_covers_reading_exit_and_descendants() {
        let start = Instant::now();
        assert_eq!(shell("sleep 3", 1024, 0.2), None, "silent child");
        assert_eq!(
            shell(
                "i=0; while [ $i -lt 30 ]; do echo $i; sleep 0.1; i=$((i+1)); done",
                1 << 20,
                0.3
            ),
            None,
            "slow trickle past the deadline"
        );
        assert_eq!(
            shell("sleep 3 & echo started", 1024, 0.3),
            None,
            "a descendant keeps the pipe open"
        );
        assert!(
            start.elapsed() < Duration::from_millis(2500),
            "a deadline was not enforced"
        );
        assert_eq!(shell("head -c 5000 /dev/zero", 1024, 5.0), None, "oversize");
        assert_eq!(shell("exit 3", 1024, 5.0), None, "non-zero exit");
        assert_eq!(shell("echo ok", 1024, 5.0).as_deref(), Some("ok\n"));
    }
}
