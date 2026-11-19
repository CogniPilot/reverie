//! Read-only acceptance for pinned session identity across an operator-managed restart.
use super::office::{self, FetchError};
use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    env,
    error::Error,
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::ExitCode,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Clone, Copy, ValueEnum)]
enum Mode {
    Before,
    After,
}

#[derive(Parser)]
#[command(
    name = "cargo persistent-ids-acceptance",
    about = "Compare pinned session identities before and after a console restart"
)]
struct Args {
    mode: Mode,
    #[arg(default_value = "persistent-ids-snapshot.json")]
    file: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: String,
    name: Option<String>,
    mode: Option<String>,
    pinned: Option<bool>,
    pid: Option<u32>,
    open_code_config: Option<OpenCode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCode {
    continue_session: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SessionList {
    Wrapped { sessions: Vec<Session> },
    List(Vec<Session>),
}

#[derive(Deserialize)]
struct Rooms {
    rooms: Vec<Room>,
}

#[derive(Deserialize)]
struct Room {
    id: String,
    name: String,
    members: Vec<Member>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Member {
    session_id: String,
    role: Option<String>,
}

#[derive(Deserialize)]
struct Company {
    employees: Vec<Employee>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Employee {
    id: String,
    session_id: Option<String>,
}

// Preserve the snapshot format produced by the former acceptance script.
#[derive(Deserialize, Serialize)]
struct Snapshot {
    sessions: BTreeMap<String, PinnedSession>,
    rooms: BTreeMap<String, SavedRoom>,
    employees: BTreeMap<String, Option<String>>,
}

#[derive(Deserialize, Serialize)]
struct PinnedSession {
    name: Option<String>,
    mode: Option<String>,
    pinned: bool,
    alive: bool,
    thread: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct SavedRoom {
    name: String,
    members: BTreeMap<String, Option<String>>,
}

fn decode<T: DeserializeOwned>(mut value: Value) -> Result<T> {
    if value["success"].as_bool() == Some(false) {
        return Err("console reported an unsuccessful snapshot request".into());
    }
    let body = value.get_mut("data").map(Value::take).unwrap_or(value);
    Ok(serde_json::from_value(body)?)
}

fn capture(base: &str) -> Result<Snapshot> {
    let [sessions, rooms, company] =
        office::continuity_snapshot(base).map_err(|error| match error {
            FetchError::Http(status) => {
                format!("console rejected snapshot request (HTTP {status})")
            }
            other => other.message().to_owned(),
        })?;
    let (SessionList::Wrapped { sessions } | SessionList::List(sessions)) = decode(sessions)?;
    let Rooms { rooms } = decode(rooms)?;
    let Company { employees } = decode(company)?;
    Ok(Snapshot {
        sessions: sessions
            .into_iter()
            .map(|session| {
                let saved = PinnedSession {
                    name: session.name,
                    mode: session.mode,
                    pinned: session.pinned.unwrap_or(false),
                    alive: session.pid.is_some(),
                    thread: session
                        .open_code_config
                        .and_then(|config| config.continue_session),
                };
                (session.id, saved)
            })
            .collect(),
        rooms: rooms
            .into_iter()
            .map(|room| {
                let members = room
                    .members
                    .into_iter()
                    .map(|m| (m.session_id, m.role))
                    .collect();
                (
                    room.id,
                    SavedRoom {
                        name: room.name,
                        members,
                    },
                )
            })
            .collect(),
        employees: employees
            .into_iter()
            .map(|e| (e.id, e.session_id))
            .collect(),
    })
}

fn save(path: &Path, snapshot: &Snapshot) -> Result<()> {
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random)
        .map_err(|_| io::Error::other("could not name the snapshot temporary file"))?;
    let temp = path.with_file_name(format!(
        ".reverie-snapshot-{:016x}.tmp",
        u64::from_ne_bytes(random)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    let result = (|| -> Result<()> {
        serde_json::to_writer(&mut file, snapshot)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

struct Report {
    failures: usize,
}

impl Report {
    fn check(&mut self, passed: bool, text: std::fmt::Arguments<'_>) {
        let status = if passed { "PASS" } else { "FAIL" };
        println!("{status} {text}");
        self.failures += usize::from(!passed);
    }
}

fn compare_sessions(before: &Snapshot, current: &Snapshot, report: &mut Report) {
    for (id, saved) in before.sessions.iter().filter(|(_, session)| session.pinned) {
        let name = saved.name.as_deref().unwrap_or(id);
        let live = current.sessions.get(id);
        if !saved.alive {
            report.check(
                live.is_none_or(|session| !session.alive),
                format_args!("{name} ({id}) was not running and stays down"),
            );
            continue;
        }
        report.check(
            live.is_some_and(|session| session.alive),
            format_args!("{name} ({id}) is back under the SAME id"),
        );
        if let Some(thread) = saved.thread.as_deref().filter(|thread| !thread.is_empty()) {
            report.check(
                live.and_then(|session| session.thread.as_deref()) == Some(thread),
                format_args!("{name} ({id}) resumes the same native thread {thread}"),
            );
        }
        let duplicates = current
            .sessions
            .values()
            .filter(|session| session.alive && session.name == saved.name)
            .count();
        report.check(
            duplicates <= 1,
            format_args!("{name} ({id}) has no duplicate live session (found {duplicates})"),
        );
    }
}

fn compare_bindings(before: &Snapshot, current: &Snapshot, report: &mut Report) {
    for (id, room) in &before.rooms {
        for (session_id, role) in &room.members {
            if let Some(session) = before
                .sessions
                .get(session_id)
                .filter(|session| session.pinned)
            {
                let name = session.name.as_deref().unwrap_or(session_id);
                report.check(
                    current
                        .rooms
                        .get(id)
                        .and_then(|room| room.members.get(session_id))
                        == Some(role),
                    format_args!(
                        "room {} keeps {name} as {}",
                        room.name,
                        role.as_deref().unwrap_or("None")
                    ),
                );
            }
        }
    }
    for (id, session) in &before.employees {
        if let Some(session) = session.as_deref().filter(|id| {
            before
                .sessions
                .get(*id)
                .is_some_and(|session| session.pinned)
        }) {
            report.check(
                current.employees.get(id).and_then(|id| id.as_deref()) == Some(session),
                format_args!("company employee {id} stays bound to {session}"),
            );
        }
    }
}

fn run(args: Args) -> Result<bool> {
    let api = env::var("CONSOLE_API").unwrap_or_else(|_| "http://127.0.0.1:3001".into());
    let current = capture(&api)?;
    match args.mode {
        Mode::Before => {
            save(&args.file, &current)?;
            let names = current
                .sessions
                .iter()
                .filter(|(_, session)| session.pinned)
                .map(|(id, session)| {
                    session
                        .name
                        .as_deref()
                        .filter(|name| !name.is_empty())
                        .unwrap_or(id)
                })
                .collect::<Vec<_>>();
            println!(
                "saved {} - {} pinned session(s): {}",
                args.file.display(),
                names.len(),
                names.join(", ")
            );
            Ok(true)
        }
        Mode::After => {
            let before = serde_json::from_reader(fs::File::open(args.file)?)?;
            let mut report = Report { failures: 0 };
            compare_sessions(&before, &current, &mut report);
            compare_bindings(&before, &current, &mut report);
            if report.failures == 0 {
                println!("RESULT: PASS");
                Ok(true)
            } else {
                println!("RESULT: {} FAIL(S)", report.failures);
                Ok(false)
            }
        }
    }
}

pub(super) fn entry(args: impl Iterator<Item = OsString>) -> ExitCode {
    let args =
        Args::parse_from(std::iter::once(OsString::from("persistent-ids-acceptance")).chain(args));
    match run(args) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("persistent-ids-acceptance: {error}");
            ExitCode::FAILURE
        }
    }
}
