//! `reverie-lease`: the lease-directory command of `cleanup/lease.py`
//! (contract r10), over `reverie_host::lease`. Liveness is only a kernel
//! lock or a reservation window, never a PID, heartbeat or metadata.
use clap::{Parser, Subcommand};
use nix::sys::signal::{SigSet, SigmaskHow, Signal, killpg, pthread_sigmask};
use nix::unistd::Pid;
use reverie_contracts::lease_records::{check_report_bytes, gc_report_bytes};
use reverie_host::lease::{
    self, CheckState, LeaseBase, LeaseCode, LeaseError, Listing, spawn_new_session,
};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::{Duration, Instant};

const EXIT_CODES: &str = "EXIT CODES:\n  run: the command's code. check: 0 free, 1 in use, 2 unknown.\n  hold/run: 3 busy barrier or replaced dir. Other lease errors: 2.\n\nLEASE DIR:\n  Holders use the first --leases-dir, else $REVERIE_LEASE_DIR, else\n  ~/.local/state/reverie/leases; `check` checks every --leases-dir given.";

/// Build leases for disposable directories: shared kernel locks for holders,
/// time-bound reservations, and the janitor's check.
#[derive(Parser)]
#[command(name = "lease", after_long_help = EXIT_CODES)]
struct Cli {
    /// Seconds to wait at a busy barrier.
    #[arg(long, default_value_t = 60.0)]
    wait: f64,
    /// Lease dir (configuration). Holders use the first; `check` checks every one.
    #[arg(long = "leases-dir")]
    leases_dir: Vec<PathBuf>,
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Hold DIRs for the command's life, then end its session and release.
    Run {
        #[arg(required = true)]
        dirs: Vec<PathBuf>,
        #[arg(last = true, required = true)]
        command: Vec<OsString>,
    },
    /// Hold DIR until SIGTERM or SIGINT; prints `LEASED <key>`.
    Hold { dir: PathBuf },
    /// Reserve DIR for 90m, 6h or 1d (at most 24 h).
    Reserve {
        dir: PathBuf,
        #[arg(long = "for")]
        duration: String,
        #[arg(long = "compute-lease-id")]
        compute_lease_id: Option<String>,
    },
    /// Rewrite DIR's existing reservation window.
    Renew {
        dir: PathBuf,
        #[arg(long = "for")]
        duration: String,
        #[arg(long = "compute-lease-id")]
        compute_lease_id: Option<String>,
    },
    /// Drop DIR's reservation.
    Unreserve { dir: PathBuf },
    /// The janitor's test without deleting.
    Check {
        dir: PathBuf,
        /// Highest ancestor to check.
        #[arg(long)]
        root: Option<PathBuf>,
    },
    /// Remove records of dead holders and leases of removed directories.
    Gc,
    /// Held leases and live reservations.
    Ls,
}

/// `--wait`: Python's float; `inf`/`nan` never expire, negatives try once.
fn wait(seconds: f64) -> Duration {
    if seconds.is_nan() || seconds == f64::INFINITY {
        Duration::MAX
    } else {
        Duration::try_from_secs_f64(seconds.max(0.0)).unwrap_or(Duration::MAX)
    }
}

/// `leases_dir()`: the holder's own lease dir, created when missing.
fn own_base(cli: &Cli) -> Result<LeaseBase, LeaseError> {
    let path = cli.leases_dir.first().cloned().or_else(|| {
        std::env::var_os("REVERIE_LEASE_DIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    });
    let path = path.unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join(".local/state/reverie/leases")
    });
    LeaseBase::own(&path)
}

fn text(path: &Path) -> Vec<u32> {
    reverie_core::posix_text::decode(std::os::unix::ffi::OsStrExt::as_bytes(path.as_os_str()))
}

fn points(text: &str) -> Vec<u32> {
    text.chars().map(u32::from).collect()
}

fn print(bytes: &[u8]) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(bytes);
    let _ = stdout.flush();
}

fn check(cli: &Cli, dir: &Path, root: Option<&Path>) -> i32 {
    let bases = if cli.leases_dir.is_empty() {
        own_base(cli).map(|base| vec![base])
    } else {
        cli.leases_dir
            .iter()
            .map(|path| LeaseBase::scan(path))
            .collect()
    };
    let (state, why) = match bases {
        Ok(bases) => lease::check(dir, root, &bases),
        Err(error) => (CheckState::Unknown, error.to_string()),
    };
    let (name, code) = match state {
        CheckState::Free => ("free", 0),
        CheckState::InUse => ("in use", 1),
        CheckState::Unknown => ("unknown", 2),
    };
    let absolute = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    print(&check_report_bytes(&text(&absolute), name, &points(&why)));
    code
}

/// End the command's session: SIGTERM, then SIGKILL, each awaited briefly.
fn kill_session(group: Pid) {
    for (signal, grace) in [(Signal::SIGTERM, 10), (Signal::SIGKILL, 5)] {
        if killpg(group, signal).is_err() {
            return;
        }
        let deadline = Instant::now() + Duration::from_secs(grace);
        while Instant::now() < deadline {
            if killpg(group, None).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn signals(names: &[Signal]) -> SigSet {
    let mut set = SigSet::empty();
    for signal in names {
        set.add(*signal);
    }
    set
}

/// `lease run`: forwarded SIGTERM/SIGINT/SIGHUP reach the command's group;
/// they are masked from the start, so none is lost while acquiring.
fn run(cli: &Cli, dirs: &[PathBuf], command: &[OsString]) -> Result<i32, LeaseError> {
    let forwarded = signals(&[Signal::SIGTERM, Signal::SIGINT, Signal::SIGHUP]);
    pthread_sigmask(SigmaskHow::SIG_BLOCK, Some(&forwarded), None).map_err(std::io::Error::from)?;
    let base = own_base(cli)?;
    let _held = lease::hold(&base, dirs, Path::new(&command[0]), wait(cli.wait))?;
    let mut child = spawn_new_session(Command::new(&command[0]).args(&command[1..]))?;
    let group = Pid::from_raw(i32::try_from(child.id()).unwrap_or(i32::MAX));
    std::thread::spawn(move || {
        while let Ok(signal) = forwarded.wait() {
            let _ = killpg(group, signal);
        }
    });
    let status = child.wait()?;
    kill_session(group);
    Ok(std::os::unix::process::ExitStatusExt::signal(&status)
        .map_or_else(|| status.code().unwrap_or(0), |signal| -signal))
}

/// `lease hold`: for supervisors that reap their own children.
fn hold_until_term(cli: &Cli, dir: &Path) -> Result<i32, LeaseError> {
    let stop = signals(&[Signal::SIGTERM, Signal::SIGINT]);
    pthread_sigmask(SigmaskHow::SIG_BLOCK, Some(&stop), None).map_err(std::io::Error::from)?;
    let base = own_base(cli)?;
    let held = lease::hold(
        &base,
        &[dir.to_path_buf()],
        Path::new("lease-hold"),
        wait(cli.wait),
    )?;
    print(format!("LEASED {}\n", held.keys()[0]).as_bytes());
    let _ = stop.wait();
    Ok(0)
}

fn listing(base: &LeaseBase) -> Result<String, LeaseError> {
    let leases = match lease::ls(base)? {
        Listing::Busy => return Ok("{\n \"busy\": true\n}\n".into()),
        Listing::Leases(leases) => leases,
    };
    let value = leases
        .into_iter()
        .map(|entry| {
            serde_json::json!({
                "key": entry.key,
                "held": entry.held,
                "reserved": entry.reserved,
                "malformedMetadata": entry.malformed_metadata,
                "path": entry.path,
                "holders": entry
                    .holders
                    .iter()
                    .filter_map(|raw| serde_json::from_slice::<serde_json::Value>(raw).ok())
                    .collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    serde::Serialize::serialize(&value, &mut serializer).map_err(std::io::Error::from)?;
    out.push(b'\n');
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn dispatch(cli: &Cli) -> Result<i32, LeaseError> {
    match &cli.action {
        Action::Run { dirs, command } => run(cli, dirs, command),
        Action::Hold { dir } => hold_until_term(cli, dir),
        Action::Reserve {
            dir,
            duration,
            compute_lease_id,
        }
        | Action::Renew {
            dir,
            duration,
            compute_lease_id,
        } => {
            let renew = matches!(cli.action, Action::Renew { .. });
            let key = lease::reserve(
                &own_base(cli)?,
                dir,
                duration,
                "",
                compute_lease_id.as_deref(),
                wait(cli.wait),
                renew,
            )?;
            print(format!("{key}\n").as_bytes());
            Ok(0)
        }
        Action::Unreserve { dir } => {
            lease::unreserve(&own_base(cli)?, dir, wait(cli.wait)).map(|()| 0)
        }
        Action::Check { dir, root } => Ok(check(cli, dir, root.as_deref())),
        Action::Gc => {
            let report = lease::gc(&own_base(cli)?)?;
            let list = |keys: &[String]| keys.iter().map(|key| points(key)).collect::<Vec<_>>();
            print(&gc_report_bytes(
                &list(&report.removed),
                &list(&report.kept_no_path_record),
            ));
            Ok(0)
        }
        Action::Ls => {
            print(listing(&own_base(cli)?)?.as_bytes());
            Ok(0)
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let code = dispatch(&cli).unwrap_or_else(|error| {
        eprintln!("lease: {error}");
        match error.code() {
            LeaseCode::InUse => 1,
            LeaseCode::Unknown => 2,
            LeaseCode::Busy => 3,
        }
    });
    // Python `SystemExit(code)`: the status is the low byte, so -15 exits 241.
    ExitCode::from(u8::try_from(code.rem_euclid(256)).unwrap_or(2))
}
