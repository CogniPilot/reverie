//! Fixed test-only programs. The intentional orphan never leaves the owned
//! container; PID1 becomes its real kernel parent before the marker is written.
use super::*;
mod pin;
use std::{
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn namespace(scope: &transport::Scope) {
    assert_eq!(std::env::var("REVERIE_INIT_PROBE").as_deref(), Ok("1"));
    assert_eq!(nix::unistd::geteuid().as_raw(), 1000);
    assert!(std::process::id() > 1);
    let status = scope.read("/proc/self/status", 65536).unwrap();
    for (name, expected) in [
        ("CapEff", "0000000000000000"),
        ("CapPrm", "0000000000000000"),
        ("NoNewPrivs", "1"),
        ("Seccomp", "2"),
    ] {
        assert_eq!(status_field(&status, name), expected, "{name}");
    }
    assert_eq!(std::env::current_exe().unwrap(), Path::new(PROBE));
    let actual = fs::metadata("/proc/1/exe").unwrap();
    let sealed = fs::symlink_metadata(INIT).unwrap();
    assert_eq!((actual.dev(), actual.ino()), (sealed.dev(), sealed.ino()));
    assert_eq!(
        scope.read("/proc/1/cmdline", 4096).unwrap(),
        format!("{INIT}\0")
    );
    assert!(
        scope
            .read("/proc/sys/kernel/hostname", 4096)
            .unwrap()
            .trim()
            .starts_with("initfixture")
    );
}

pub(super) fn parent(scope: &transport::Scope) -> std::process::Child {
    namespace(scope);
    Command::new(PROBE)
        .args([
            "--ignored",
            "--exact",
            CHILD,
            "--test-threads=1",
            "--nocapture",
        ])
        .env("REVERIE_INIT_PHASE", transport::Phase::Child.name())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

pub(super) fn child(scope: &transport::Scope) {
    namespace(scope);
    let end = Instant::now() + Duration::from_secs(10);
    while status_field(&scope.read("/proc/self/status", 65536).unwrap(), "PPid") != "1" {
        assert!(Instant::now() < end, "actual orphan was not adopted");
        std::thread::sleep(Duration::from_millis(5));
    }
    write_marker(
        scope,
        "/tmp/init-adopted.pending",
        &std::process::id().to_string(),
    );
    fs::rename("/tmp/init-adopted.pending", "/tmp/init-adopted").unwrap();
    while !Path::new("/tmp/init-release").exists() {
        assert!(
            Instant::now() < end,
            "original observer did not release orphan"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub(super) fn observer(scope: &transport::Scope) -> u32 {
    namespace(scope);
    let end = Instant::now() + Duration::from_secs(5);
    let pid = loop {
        match scope.read("/tmp/init-adopted", 16) {
            Ok(raw) => {
                assert!(raw.len() <= 16);
                break raw.parse::<u32>().unwrap();
            }
            Err(crate::ObservationError::Io(error))
                if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("adoption marker: {error}"),
        }
        assert!(Instant::now() < end, "actual adoption marker unavailable");
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(pid > 1 && pid != std::process::id());
    let mut pinned = pin::OriginalChild::open(scope, pid);
    let body = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        observe_reaping(scope, pid, &pinned, end);
    }));
    let closed = pinned.close();
    if let Err(error) = &closed {
        eprintln!("ORPHAN_PIDFD_CLOSE_RETAINED {error}");
    }
    if let Err(error) = body {
        std::panic::resume_unwind(error);
    }
    closed.unwrap();
    pid
}
fn observe_reaping(
    scope: &transport::Scope,
    pid: u32,
    pinned: &pin::OriginalChild<'_>,
    end: Instant,
) {
    let path = format!("/proc/{pid}/status");
    let status = scope.read(&path, 65536).unwrap();
    assert_eq!(status_field(&status, "Pid"), pid.to_string());
    assert_eq!(status_field(&status, "PPid"), "1");
    assert!(!status_field(&status, "State").starts_with('Z'));
    println!("INIT_ADOPTED child={pid} ppid=1");
    write_marker(scope, "/tmp/init-release", "exit");
    loop {
        match scope.read(&path, 65536) {
            Err(crate::ObservationError::Io(error))
                if error.kind() == std::io::ErrorKind::NotFound =>
            {
                if pinned.dead() {
                    break;
                }
            }
            Ok(status) => {
                assert_eq!(status_field(&status, "PPid"), "1");
                pinned.current();
            }
            Err(error) => panic!("original child observation: {error}"),
        }
        assert!(
            Instant::now() < end,
            "original orphan still exists (including zombies)"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    println!("INIT_REAPED child={pid}");
}
fn status_field<'a>(raw: &'a str, field: &str) -> &'a str {
    raw.lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(key, _)| *key == field)
                .map(|(_, value)| value.trim())
        })
        .unwrap()
}
fn write_marker(scope: &transport::Scope, path: &str, raw: &str) {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    let body = file
        .write_all(raw.as_bytes())
        .and_then(|()| file.sync_all());
    // Every opened marker is checked closed even when write/fsync fails.
    // The exact native close result latches transport uncertainty separately.
    let closed = scope.checked(crate::native::close(file));
    if let Err(error) = &closed {
        eprintln!("ORPHAN_MARKER_CLOSE_RETAINED {error}");
    }
    body.unwrap();
    closed.unwrap();
}
