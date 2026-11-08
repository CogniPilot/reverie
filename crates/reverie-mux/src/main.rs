//! `reverie-mux`: the console's tmux sessions from a terminal.
use nix::sys::signal::{Signal as NixSignal, kill, killpg};
use nix::unistd::Pid;
use reverie_mux::{
    Error, Host, Instance, Sessions, Signal, Target, USAGE, info, list, parse_selection,
};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};

/// Field 4 of `/proc/<pid>/stat`, after the parenthesised command name.
fn parent_of(pid: i32) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, rest) = stat.rsplit_once(')')?;
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// The real tmux, signals and `/proc`.
struct System;

impl Host for System {
    fn tmux_available(&mut self) -> Result<(), Error> {
        let output = Command::new("tmux")
            .arg("-V")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|error| Error(format!("tmux is not available: {error}")))?;
        if !output.status.success() {
            return Err(Error(format!("tmux -V failed: {}", output.status)));
        }
        Ok(())
    }

    fn tmux(&mut self, socket: &str, args: &[&str]) -> Result<Option<String>, Error> {
        let output = Command::new("tmux")
            .arg("-L")
            .arg(socket)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|error| Error(format!("tmux could not be run: {error}")))?;
        Ok(output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned()))
    }

    fn signal(&mut self, target: Target, signal: Signal) {
        let signal = match signal {
            Signal::Term => NixSignal::SIGTERM,
            Signal::Kill => NixSignal::SIGKILL,
        };
        let _ = match target {
            Target::Process(pid) => kill(Pid::from_raw(pid), signal),
            Target::Group(pid) => killpg(Pid::from_raw(pid), signal),
        };
    }

    fn children(&mut self, pid: i32) -> Vec<i32> {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        entries
            .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<i32>().ok())
            .filter(|child| parent_of(*child) == Some(pid))
            .collect()
    }

    fn rss_kib(&mut self, pid: i32) -> Option<u64> {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
        line.split_whitespace().nth(1)?.parse().ok()
    }

    fn now(&mut self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| {
                i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
            })
    }
}

fn index_argument(
    argument: Option<&str>,
    command: &str,
    sessions: &Sessions,
) -> Result<usize, Error> {
    let spec = argument.ok_or_else(|| Error(format!("Usage: reverie-mux {command} <N>")))?;
    if spec.contains([',', '-']) {
        return Err(Error(format!("Usage: reverie-mux {command} <N>")));
    }
    Ok(parse_selection(spec, sessions.len())?[0])
}

/// Prints a kill report; a `FAILED:` line makes the command fail after the report is shown.
fn print_report(report: &[String]) -> Result<(), Error> {
    let mut failed = None;
    for line in report {
        match line.strip_prefix("FAILED: ") {
            Some(reason) => failed = Some(reason.to_owned()),
            None => println!("{line}"),
        }
    }
    failed.map_or(Ok(()), |reason| Err(Error(reason)))
}

fn run(args: &[String]) -> Result<(), Error> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let instance = Instance::resolve(&|name| std::env::var(name).ok(), &home);
    let mut host = System;
    let command = args.first().map_or("list", String::as_str);
    let argument = args.get(1).map(String::as_str);
    if matches!(command, "help" | "--help" | "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    // Every command reads tmux state; without tmux, alive and dead cannot be told apart.
    host.tmux_available()?;
    let mut sessions = Sessions::load(&instance.sessions_file)?;
    match command {
        "list" | "ls" => print!("{}", list(&mut host, &instance, &sessions)?),
        "info" => {
            let index = index_argument(argument, "info", &sessions)?;
            print!("{}", info(&mut host, &instance, &sessions.session(index))?);
        }
        "attach" => {
            let index = index_argument(argument, "attach", &sessions)?;
            let name = sessions.session(index).mux_name;
            if host
                .tmux(&instance.socket, &["has-session", "-t", &name])?
                .is_none()
            {
                return Err(Error("Session dead or not found".into()));
            }
            let error = Command::new("tmux")
                .args(["-L", &instance.socket, "attach-session", "-t", &name])
                .exec();
            return Err(Error(format!("tmux: {error}")));
        }
        "kill" => {
            let spec =
                argument.ok_or_else(|| Error("Usage: reverie-mux kill <N|N,M|N-M>".into()))?;
            let selected = parse_selection(spec, sessions.len())?;
            let report = reverie_mux::kill(&mut host, &instance, &mut sessions, &selected)?;
            print_report(&report)?;
        }
        "kill-all" => {
            let selected: Vec<usize> = (0..sessions.len()).collect();
            let report = reverie_mux::kill(&mut host, &instance, &mut sessions, &selected)?;
            let killed = report
                .iter()
                .filter(|line| line.starts_with("Killed"))
                .count();
            let printed = print_report(&report);
            println!("{killed} sessions killed");
            printed?;
        }
        other => return Err(Error(format!("Unknown command: {other}\n\n{USAGE}"))),
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("reverie-mux: {error}");
            ExitCode::FAILURE
        }
    }
}
