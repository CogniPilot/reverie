//! `reverie-observations`: `cleanup/collector_user.py main()`. Opt-in USER
//! observations; any refusal prints one line and exits 2.
use clap::Parser;
use reverie_observations::Owner;
use reverie_observations::Refused;
use reverie_observations::user::{Action, Context, Shown, Systemd, run};
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

/// Opt-in USER observations. This never adopts the root collector or grants effects.
#[derive(Parser)]
#[command(name = "reverie-observations")]
struct Cli {
    #[arg(long, overrides_with = "config")]
    config: Option<PathBuf>,
    #[arg(value_parser = ["init", "install", "enable", "disable", "start", "stop", "status", "sample"])]
    action: String,
}

/// A root-owned, immutable regular file under the store at its own path.
fn packaged(path: &Path) -> bool {
    std::fs::canonicalize(path).is_ok_and(|real| real == path)
        && path.starts_with("/nix/store")
        && std::fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.uid() == 0 && meta.mode() & 0o222 == 0)
}

/// `systemctl --user` from the package, checked on every use.
struct HostSystemd;

impl HostSystemd {
    fn systemctl() -> Result<Command, Refused> {
        let path = option_env!("REVERIE_SYSTEMCTL").map(PathBuf::from);
        let path = path
            .filter(|path| packaged(path))
            .ok_or(Refused("Immutable packaged tools required"))?;
        let mut command = Command::new(path);
        command.arg("--user");
        Ok(command)
    }
}

/// Wait for `child` until `timeout`, killing it after; `None` on timeout.
fn wait(child: &mut Child, timeout: Duration) -> Option<i32> {
    let end = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.code().unwrap_or(-1)),
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

impl Systemd for HostSystemd {
    fn entry(&self) -> Result<String, Refused> {
        let refusal = Refused("Service control requires the immutable packaged entry");
        let entry = std::env::current_exe().map_err(|_| refusal)?;
        let entry = std::fs::canonicalize(entry).map_err(|_| refusal)?;
        if !packaged(&entry) {
            return Err(refusal);
        }
        entry.to_str().map(str::to_owned).ok_or(refusal)
    }

    fn show(&mut self, args: &[&str]) -> Result<Shown, Refused> {
        let unavailable = Refused("Unit observation unavailable");
        let mut child = Self::systemctl()?
            .arg("show")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| unavailable)?;
        let mut stdout = child.stdout.take().ok_or(unavailable)?;
        let reader = std::thread::spawn(move || {
            let mut data = Vec::new();
            let _ = stdout.by_ref().take(1 << 20).read_to_end(&mut data);
            data
        });
        let status = wait(&mut child, Duration::from_secs(3)).ok_or(unavailable)?;
        let data = reader.join().map_err(|_| unavailable)?;
        let stdout = String::from_utf8(data).map_err(|_| unavailable)?;
        Ok(Shown { status, stdout })
    }

    fn control(&mut self, args: &[&str], timeout: Duration) -> Result<(), Refused> {
        let refused = Refused("Unit control failed");
        let mut child = Self::systemctl()?.args(args).spawn().map_err(|_| refused)?;
        match wait(&mut child, timeout) {
            Some(0) => Ok(()),
            _ => Err(refused),
        }
    }
}

/// `Path.home()`: `$HOME` when set, else the passwd entry.
fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).or_else(|| {
        nix::unistd::User::from_uid(nix::unistd::getuid())
            .ok()
            .flatten()
            .map(|user| user.dir)
    })
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let action = match cli.action.as_str() {
        "init" => Action::Init,
        "install" => Action::Install,
        "enable" => Action::Enable,
        "disable" => Action::Disable,
        "start" => Action::Start,
        "stop" => Action::Stop,
        "status" => Action::Status,
        _ => Action::Sample,
    };
    let config = cli
        .config
        .or_else(|| home().map(|home| home.join("reverie/resource-history/config.json")))
        .unwrap_or_default();
    // Python checks the path before its refusal handler: an uncaught error.
    if reverie_observations::canonical_config(&config).is_err() {
        let _ = writeln!(
            std::io::stderr(),
            "ValueError: Canonical absolute path required"
        );
        return ExitCode::from(1);
    }
    let owner = match Owner::current() {
        Ok(owner) => owner,
        Err(_) => {
            let _ = writeln!(
                std::io::stderr(),
                "User observation operation refused or unavailable"
            );
            return ExitCode::from(2);
        }
    };
    let mut systemd = HostSystemd;
    let mut context = Context {
        owner: &owner,
        home: home().unwrap_or_default(),
        systemd: &mut systemd,
        proc_cgroup: PathBuf::from("/proc/self/cgroup"),
        cgroup_root: PathBuf::from("/sys/fs/cgroup"),
    };
    ExitCode::from(u8::try_from(run(&mut context, &config, action)).unwrap_or(2))
}
