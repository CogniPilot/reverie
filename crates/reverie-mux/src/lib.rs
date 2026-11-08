//! The console's tmux sessions from a terminal: list, inspect, attach and kill them, with or
//! without the console running.
//!
//! The session list is the console's own `mux-sessions.json` in its data directory, and the
//! sessions live on its dedicated tmux socket. Both are resolved exactly as the console resolves
//! them, so this tool sees the sessions of the instance it is pointed at. Every tmux call, signal
//! and process lookup goes through [`Host`], so tests run without tmux or real processes.
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A refusal or failure, printed as `reverie-mux: <message>` with exit status 1.
#[derive(Debug)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self(error.to_string())
    }
}

/// The signals a kill sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
}

/// Where a kill sends a signal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Process(i32),
    Group(i32),
}

/// What the tool touches outside its own memory.
pub trait Host {
    /// Whether tmux itself can run (`tmux -V`), independent of any server.
    fn tmux_available(&mut self) -> Result<(), Error>;
    /// Runs tmux on `socket` with `args`: its stdout when it succeeds, `None` when it ran and
    /// failed (no server, no such session), and an error when it could not be run at all.
    fn tmux(&mut self, socket: &str, args: &[&str]) -> Result<Option<String>, Error>;
    /// Sends `signal` to `target`, ignoring a process that is already gone.
    fn signal(&mut self, target: Target, signal: Signal);
    /// The direct children of `pid`.
    fn children(&mut self, pid: i32) -> Vec<i32>;
    /// Resident memory of `pid` in KiB, if it is running.
    fn rss_kib(&mut self, pid: i32) -> Option<u64>;
    /// Seconds since the Unix epoch.
    fn now(&mut self) -> i64;
}

/// The instance's session file and tmux socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instance {
    pub sessions_file: PathBuf,
    pub socket: String,
    /// The tmux pane this tool runs in, when that pane is on the instance socket.
    pub own_pane: Option<String>,
}

impl Instance {
    /// Resolves the instance from the console's environment variables, as the console does:
    /// `REVERIE_DATA_DIR` or `~/.reverie[-<instance>]`, and `REVERIE_TMUX_SOCKET` when it is a
    /// safe name, else `reverie[-<instance>]`. The tool is inside one of the instance's sessions
    /// only when `TMUX` names that socket; then `TMUX_PANE` is its pane.
    pub fn resolve(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Self {
        let set = |name: &str| env(name).filter(|value| !value.is_empty());
        let suffix = set("REVERIE_INSTANCE")
            .map(|name| {
                let safe: String = name
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                    .take(32)
                    .collect();
                // A non-empty name always adds the dash, even when nothing of it is safe, as the
                // console's own resolver does.
                format!("-{safe}")
            })
            .unwrap_or_default();
        let data = set("REVERIE_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(format!(".reverie{suffix}")));
        let socket = set("REVERIE_TMUX_SOCKET")
            .filter(|name| {
                name.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            })
            .unwrap_or_else(|| format!("reverie{suffix}"));
        // TMUX is "<socket path>,<server pid>,<session index>".
        let inside = set("TMUX").is_some_and(|value| {
            let path = value.split(',').next().unwrap_or_default();
            Path::new(path)
                .file_name()
                .is_some_and(|name| name == socket.as_str())
        });
        Self {
            sessions_file: data.join("mux-sessions.json"),
            own_pane: set("TMUX_PANE").filter(|_| inside),
            socket,
        }
    }
}

/// One tracked session, read from its record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub name: String,
    pub session_id: String,
    pub mux_name: String,
    pub pid: Option<i32>,
    pub created_at_ms: Option<i64>,
    pub mode: String,
    pub working_dir: String,
}

fn text(record: &serde_json::Value, key: &str, missing: &str) -> String {
    record[key].as_str().unwrap_or(missing).to_owned()
}

impl Session {
    fn from_record(record: &serde_json::Value) -> Self {
        let mux_name = record["muxName"]
            .as_str()
            .or_else(|| record["screenName"].as_str());
        Self {
            name: text(record, "name", "unnamed"),
            session_id: text(record, "sessionId", "unknown"),
            mux_name: mux_name.unwrap_or("unknown").to_owned(),
            pid: record["pid"]
                .as_i64()
                .and_then(|pid| i32::try_from(pid).ok()),
            created_at_ms: record["createdAt"].as_i64(),
            mode: text(record, "mode", "unknown"),
            working_dir: text(record, "workingDir", "unknown"),
        }
    }
}

/// The console's session records, kept whole so a rewrite drops only killed rows.
pub struct Sessions {
    file: PathBuf,
    records: Vec<serde_json::Value>,
}

impl Sessions {
    /// Reads the session file; a missing file is an empty list.
    pub fn load(file: &Path) -> Result<Self, Error> {
        let records = match fs::read_to_string(file) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(serde_json::Value::Array(records)) => records,
                Ok(_) => return Err(Error(format!("{} is not a session list", file.display()))),
                Err(error) => return Err(Error(format!("{}: {error}", file.display()))),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(Error(format!("{}: {error}", file.display()))),
        };
        Ok(Self {
            file: file.to_owned(),
            records,
        })
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn session(&self, index: usize) -> Session {
        Session::from_record(&self.records[index])
    }

    /// Writes the remaining records with a temporary file and a rename, as the console does.
    fn save(&self) -> Result<(), Error> {
        let body = serde_json::to_string_pretty(&self.records)
            .map_err(|error| Error(error.to_string()))?;
        let temporary = self.file.with_extension("json.mux-tmp");
        fs::write(&temporary, body)?;
        fs::rename(&temporary, &self.file)?;
        Ok(())
    }
}

/// Parses `N`, `N,M,...` or `N-M` (1-based) into 0-based indices, each checked against `count`.
pub fn parse_selection(spec: &str, count: usize) -> Result<Vec<usize>, Error> {
    let number = |word: &str| -> Result<usize, Error> {
        match word.trim().parse::<usize>() {
            Ok(n) if (1..=count).contains(&n) => Ok(n - 1),
            _ => Err(Error(format!(
                "No session #{} (there are {count})",
                word.trim()
            ))),
        }
    };
    let mut indices = match spec.split_once('-') {
        Some((start, end)) => {
            let (start, end) = (number(start)?, number(end)?);
            if start > end {
                return Err(Error(format!("Range {spec} runs backwards")));
            }
            (start..=end).collect()
        }
        None => spec.split(',').map(number).collect::<Result<Vec<_>, _>>()?,
    };
    indices.sort_unstable();
    indices.dedup();
    Ok(indices)
}

/// `90` → `1m`, `3700` → `1h 1m`, `90000` → `1d 1h`, as the old script printed it.
pub fn format_duration(seconds: i64) -> String {
    let (d, h, m) = (
        seconds / 86_400,
        (seconds % 86_400) / 3600,
        (seconds % 3600) / 60,
    );
    if d > 0 {
        format!("{d}d {h}h")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m")
    } else {
        format!("{seconds}s")
    }
}

/// The tmux session this tool runs inside, on the instance socket, if any.
/// Asked by pane: without a target, tmux answers with some session even when the caller is not
/// inside one, which the old script mistook for its own.
fn own_session(host: &mut dyn Host, instance: &Instance) -> Result<Option<String>, Error> {
    let Some(pane) = instance.own_pane.as_deref() else {
        return Ok(None);
    };
    let name = host.tmux(
        &instance.socket,
        &["display-message", "-p", "-t", pane, "#{session_name}"],
    )?;
    Ok(name
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty()))
}

fn alive(host: &mut dyn Host, socket: &str, mux_name: &str) -> Result<bool, Error> {
    Ok(host
        .tmux(socket, &["has-session", "-t", mux_name])?
        .is_some())
}

/// The table `list` prints.
pub fn list(
    host: &mut dyn Host,
    instance: &Instance,
    sessions: &Sessions,
) -> Result<String, Error> {
    if sessions.is_empty() {
        return Ok(format!(
            "No reverie sessions found in {}.\n",
            instance.sessions_file.display()
        ));
    }
    let now = host.now();
    let mut out = format!(
        "Reverie Sessions ({}):\n\n",
        instance.sessions_file.display()
    );
    out.push_str(&format!(
        "{:<4} {:<22} {:<14} {:<10} {:<8}\n",
        "#", "NAME", "RUNNING", "STATUS", "MODE"
    ));
    out.push_str(&"─".repeat(65));
    out.push('\n');
    for index in 0..sessions.len() {
        let session = sessions.session(index);
        let running = session
            .created_at_ms
            .map_or_else(|| "unknown".into(), |ms| format_duration(now - ms / 1000));
        let status = if alive(host, &instance.socket, &session.mux_name)? {
            "alive"
        } else {
            "dead"
        };
        let name = if session.name.chars().count() > 20 {
            format!("{}...", session.name.chars().take(17).collect::<String>())
        } else {
            session.name
        };
        let number = format!("[{}]", index + 1);
        out.push_str(&format!(
            "{number:<4} {name:<22} {running:<14} {status:<10} {:<8}\n",
            session.mode
        ));
    }
    Ok(out)
}

/// The details `info N` prints.
pub fn info(host: &mut dyn Host, instance: &Instance, session: &Session) -> Result<String, Error> {
    let now = host.now();
    let running = session
        .created_at_ms
        .map_or_else(|| "unknown".into(), |ms| format_duration(now - ms / 1000));
    let pid = session
        .pid
        .map_or_else(|| "unknown".into(), |pid| pid.to_string());
    let mut out = String::from("Session Details\n");
    out.push_str(&format!("  Name:        {}\n", session.name));
    out.push_str(&format!("  Session ID:  {}\n", session.session_id));
    out.push_str(&format!("  Tmux:        {}\n", session.mux_name));
    out.push_str(&format!("  PID:         {pid}\n"));
    out.push_str(&format!("  Mode:        {}\n", session.mode));
    out.push_str(&format!("  Directory:   {}\n", session.working_dir));
    out.push_str(&format!("  Running:     {running}\n"));
    if alive(host, &instance.socket, &session.mux_name)? {
        out.push_str("  Status:      alive\n");
        if let Some(kib) = session.pid.and_then(|pid| host.rss_kib(pid)) {
            out.push_str(&format!("  Memory:      {:.1} MB\n", kib as f64 / 1024.0));
        }
    } else {
        out.push_str("  Status:      dead\n");
    }
    Ok(out)
}

/// Stops one session the way the old script did: TERM its children and its process group,
/// kill the tmux session, then KILL the process. A pid that is missing or not above 1 is never
/// signalled, so a bad record cannot reach this tool's own group or init. An error means tmux
/// could not be run, so the session may still exist.
fn stop(host: &mut dyn Host, socket: &str, session: &Session) -> Result<(), Error> {
    let pid = session.pid.filter(|pid| *pid > 1);
    if let Some(pid) = pid {
        for child in host.children(pid) {
            host.signal(Target::Process(child), Signal::Term);
        }
        host.signal(Target::Group(pid), Signal::Term);
    }
    host.tmux(socket, &["kill-session", "-t", &session.mux_name])?;
    if let Some(pid) = pid {
        host.signal(Target::Process(pid), Signal::Kill);
    }
    Ok(())
}

/// Kills the selected sessions (0-based), never the one this tool runs inside, and removes
/// their records. Returns one line per session. If tmux cannot be run partway, the last line
/// starts with `FAILED:`, that session and every later one keep their records, and nothing
/// after it is attempted.
pub fn kill(
    host: &mut dyn Host,
    instance: &Instance,
    sessions: &mut Sessions,
    selected: &[usize],
) -> Result<Vec<String>, Error> {
    // Without a working tmux every session would look already gone and its record would be
    // dropped; refuse before touching anything.
    host.tmux_available()?;
    let own = own_session(host, instance)?;
    let mut report = Vec::new();
    let mut removed = Vec::new();
    for &index in selected {
        let session = sessions.session(index);
        if own.as_deref() == Some(session.mux_name.as_str()) {
            report.push(format!("SKIPPED: own tmux session {}", session.mux_name));
            continue;
        }
        if let Err(error) = stop(host, &instance.socket, &session) {
            report.push(format!(
                "FAILED: [{}] {} ({}): {error}; its record is kept",
                index + 1,
                session.name,
                session.mux_name
            ));
            break;
        }
        report.push(format!(
            "Killed [{}] {} ({})",
            index + 1,
            session.name,
            session.mux_name
        ));
        removed.push(index);
    }
    if !removed.is_empty() {
        for index in removed.iter().rev() {
            sessions.records.remove(*index);
        }
        sessions.save()?;
    }
    Ok(report)
}

/// The usage text.
pub const USAGE: &str = "Reverie tmux sessions

Usage: reverie-mux [command]

Commands:
  list, ls     List the sessions (the default)
  attach N     Attach to session N
  info N       Show session N in detail
  kill SPEC    Kill sessions: N, N,M,... or N-M
  kill-all     Kill every session except the one you are in
  help         Show this help

The interactive dashboard is `reverie tui`.";
