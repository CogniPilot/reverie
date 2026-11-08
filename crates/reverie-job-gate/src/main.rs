//! `reverie-job`: run a heavy command only when the seat has memory room for it.
use clap::{Parser, Subcommand};
use reverie_job_gate::{
    GateError, default_ledger, facts::Roots, ledger::Ledger, parse_size, release, rule, snapshot,
    try_admit,
};
use std::{
    ffi::OsString,
    path::PathBuf,
    process::{Command, ExitCode},
    thread,
    time::{Duration, Instant},
};

/// Exit status when the gate does not run the command (sysexits EX_TEMPFAIL).
const NOT_RUN: u8 = 75;

#[derive(Parser)]
#[command(
    about = "Run a heavy command (build, test suite) only when this seat has memory room for it.",
    long_about = "Reserve the command's estimated memory in this seat's ledger, wait until every reservation and the seat's non-reclaimable usage fit under a fraction of its memory cap, run the command, and release the reservation when it exits. The gate never kills or limits anything; a command started without it is seen only through measured usage.",
    after_long_help = "EXAMPLES:\n  reverie-job run --estimate 800m -- cargo test -p reverie-namegate\n  reverie-job status\n\nEXIT STATUS:\n  run: the command's own status, or 75 when the gate did not run it\n  (refused, timed out waiting, or memory facts unreadable). A command that itself\n  exits 75 looks the same. A command killed by a signal exits 128 + the signal\n  (137 for an OOM kill). A reservation the gate fails to release after the\n  command ran only warns: it lapses when the gate process exits.\n\nLEDGER:\n  REVERIE_JOB_LEDGER, else $XDG_RUNTIME_DIR/reverie-job, else\n  ~/.local/state/reverie-job, else a per-user directory under /tmp."
)]
struct Arguments {
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Wait for room, run the command, release the reservation.
    Run {
        /// Peak memory the command is expected to need: bytes, or a number with k, m or g.
        #[arg(long, value_parser = size)]
        estimate: u64,
        /// Share of the memory cap all reservations may use, in thousandths.
        #[arg(long, default_value_t = 900, value_parser = clap::value_parser!(u32).range(1..=1000))]
        permille: u32,
        /// Longest wait for room before giving up, in seconds.
        #[arg(long, default_value_t = 600)]
        wait_secs: u64,
        /// The command and its arguments.
        #[arg(required = true, last = true)]
        command: Vec<OsString>,
    },
    /// Print the memory facts, the limit and the live reservations as JSON.
    Status {
        #[arg(long, default_value_t = 900, value_parser = clap::value_parser!(u32).range(1..=1000))]
        permille: u32,
    },
}

fn size(text: &str) -> Result<u64, String> {
    parse_size(text)
        .ok_or_else(|| format!("not a size: {text} (use bytes, or a number with k, m or g)"))
}

fn roots() -> Roots {
    let path = |name: &str, default: &str| {
        std::env::var_os(name).map_or_else(|| PathBuf::from(default), PathBuf::from)
    };
    Roots {
        cgroup: path("REVERIE_JOB_CGROUP_ROOT", "/sys/fs/cgroup"),
        proc: path("REVERIE_JOB_PROC_ROOT", "/proc"),
    }
}

fn ledger_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("REVERIE_JOB_LEDGER") {
        return PathBuf::from(dir);
    }
    let uid = nix::unistd::getuid().as_raw();
    let dir = |name: &str| std::env::var_os(name).map(PathBuf::from);
    default_ledger(
        dir("XDG_RUNTIME_DIR").as_deref(),
        dir("HOME").as_deref(),
        uid,
    )
}

fn main() -> ExitCode {
    let result = match Arguments::parse().action {
        Action::Run {
            estimate,
            permille,
            wait_secs,
            command,
        } => run(estimate, permille, wait_secs, &command),
        Action::Status { permille } => status(permille),
    };
    result.unwrap_or_else(|reason| {
        eprintln!("reverie-job: {reason}");
        ExitCode::from(NOT_RUN)
    })
}

fn describe(error: GateError) -> String {
    match error {
        GateError::Unreadable(why) => format!("memory facts unreadable, refusing: {}", why.0),
        GateError::Io(error) => format!("ledger unavailable: {error}"),
    }
}

fn mib(bytes: u64) -> u64 {
    bytes >> 20
}

fn run(
    estimate: u64,
    permille: u32,
    wait_secs: u64,
    command: &[OsString],
) -> Result<ExitCode, String> {
    let ledger = Ledger::open(&ledger_dir()).map_err(|e| format!("ledger unavailable: {e}"))?;
    let roots = roots();
    let pid = std::process::id();
    let deadline = Instant::now() + Duration::from_secs(wait_secs);
    let mut said_waiting = false;
    loop {
        let attempt = try_admit(&ledger, &roots, pid, estimate, permille).map_err(describe)?;
        match attempt.decision {
            rule::Decision::Admit => break,
            rule::Decision::Refuse { estimate, limit } => {
                return Err(format!(
                    "estimate {} MiB exceeds this seat's limit of {} MiB; run it in CI or on a larger machine",
                    mib(estimate),
                    mib(limit)
                ));
            }
            rule::Decision::Wait { need, limit } => {
                if Instant::now() >= deadline {
                    return Err(format!(
                        "no room after {wait_secs} s: needs {} MiB of {} MiB",
                        mib(need),
                        mib(limit)
                    ));
                }
                if !said_waiting {
                    eprintln!(
                        "reverie-job: waiting for room: needs {} MiB of {} MiB, {} job(s) holding reservations",
                        mib(need),
                        mib(limit),
                        attempt.held.len()
                    );
                    said_waiting = true;
                }
                thread::sleep(Duration::from_secs(1));
            }
        }
    }
    let status = Command::new(&command[0]).args(&command[1..]).status();
    if let Err(error) = release(&ledger, pid) {
        // The command's outcome stands either way: the entry is stale, and pruned, once this
        // process is gone.
        eprintln!(
            "reverie-job: warning: reservation not released ({error}); it lapses when this process exits"
        );
    }
    let status =
        status.map_err(|e| format!("could not start {}: {e}", command[0].to_string_lossy()))?;
    Ok(exit_code(status))
}

/// The command's own status, or 128 + the signal that killed it (137 for an OOM kill).
fn exit_code(status: std::process::ExitStatus) -> ExitCode {
    use std::os::unix::process::ExitStatusExt;
    let code = status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(1);
    ExitCode::from(u8::try_from(code & 0xff).unwrap_or(1))
}

fn status(permille: u32) -> Result<ExitCode, String> {
    let ledger = Ledger::open(&ledger_dir()).map_err(|e| format!("ledger unavailable: {e}"))?;
    let (facts, held) = snapshot(&ledger, &roots()).map_err(describe)?;
    let rule_held: Vec<rule::Held> = held
        .iter()
        .map(|(entry, pss_anon)| rule::Held {
            reservation: entry.reservation,
            pss_anon: *pss_anon,
        })
        .collect();
    let report = serde_json::json!({
        "memoryMax": facts.max,
        "limit": rule::limit(&facts, permille),
        "baseline": rule::baseline(&facts, &rule_held),
        "charged": rule::charged(&rule_held),
        "jobs": held.iter().map(|(entry, pss_anon)| serde_json::json!({
            "pid": entry.pid, "reservation": entry.reservation, "pssAnon": pss_anon,
        })).collect::<Vec<_>>(),
    });
    println!("{report}");
    Ok(ExitCode::SUCCESS)
}
