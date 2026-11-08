//! reverie-mux against a recording host and a real session file in a scratch directory.
use reverie_mux::{
    Error, Host, Instance, Sessions, Signal, Target, format_duration, info, kill, list,
    parse_selection,
};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("reverie-mux-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Sessions in `alive` answer has-session; `own` is the session the tool runs inside.
#[derive(Default)]
struct Fake {
    alive: BTreeSet<String>,
    own: Option<String>,
    children: Vec<i32>,
    calls: Vec<String>,
    tmux_missing: bool,
    /// tmux passes `-V` but cannot be run for anything else, as when it breaks after the check.
    tmux_breaks: bool,
}

impl Host for Fake {
    fn tmux_available(&mut self) -> Result<(), Error> {
        self.calls.push("tmux -V".into());
        if self.tmux_missing {
            Err(Error(
                "tmux is not available: No such file or directory".into(),
            ))
        } else {
            Ok(())
        }
    }
    fn tmux(&mut self, socket: &str, args: &[&str]) -> Result<Option<String>, Error> {
        self.calls
            .push(format!("tmux -L {socket} {}", args.join(" ")));
        if self.tmux_breaks {
            return Err(Error("tmux could not be run: Permission denied".into()));
        }
        Ok(match args {
            ["display-message", "-p", "-t", "%7", _] => self.own.clone(),
            // Untargeted, tmux names some session even for a caller outside tmux.
            ["display-message", ..] => Some("reverie-1".into()),
            ["has-session", "-t", name] => self.alive.contains(*name).then(String::new),
            ["kill-session", "-t", name] => self.alive.remove(*name).then(String::new),
            _ => None,
        })
    }
    fn signal(&mut self, target: Target, signal: Signal) {
        self.calls.push(format!("signal {target:?} {signal:?}"));
    }
    fn children(&mut self, pid: i32) -> Vec<i32> {
        self.calls.push(format!("children {pid}"));
        self.children.clone()
    }
    fn rss_kib(&mut self, _pid: i32) -> Option<u64> {
        Some(2048)
    }
    fn now(&mut self) -> i64 {
        1_000_000
    }
}

fn record(n: u32, pid: i64) -> serde_json::Value {
    serde_json::json!({
        "sessionId": format!("id-{n}"), "muxName": format!("reverie-{n}"), "pid": pid,
        "createdAt": (1_000_000 - 3700) * 1000, "workingDir": format!("/work/{n}"),
        "mode": "zorblat", "attached": false, "name": format!("session {n}"), "respawnConfig": {"keep": n}
    })
}

fn instance(root: &Path, records: &[serde_json::Value]) -> Instance {
    let file = root.join("mux-sessions.json");
    fs::write(&file, serde_json::to_string_pretty(records).unwrap()).unwrap();
    Instance {
        sessions_file: file,
        socket: "reverie-zorblat".into(),
        own_pane: None,
    }
}

fn on_disk(instance: &Instance) -> Vec<serde_json::Value> {
    serde_json::from_str(&fs::read_to_string(&instance.sessions_file).unwrap()).unwrap()
}

#[test]
fn the_instance_is_resolved_as_the_console_resolves_it() {
    let home = Path::new("/home/someone");
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    };
    let plain = Instance::resolve(&env(&[]), home);
    assert_eq!(plain.sessions_file, home.join(".reverie/mux-sessions.json"));
    assert_eq!(plain.socket, "reverie");
    // A non-empty name with nothing safe in it still adds the dash, as the console does.
    for unsafe_name in ["!!!", "日本語"] {
        let leftover = Instance::resolve(
            &|name: &str| (name == "REVERIE_INSTANCE").then(|| unsafe_name.to_owned()),
            home,
        );
        assert_eq!(
            leftover.sessions_file,
            home.join(".reverie-/mux-sessions.json"),
            "{unsafe_name}"
        );
        assert_eq!(leftover.socket, "reverie-", "{unsafe_name}");
    }
    let named = Instance::resolve(&env(&[("REVERIE_INSTANCE", "beta/../x")]), home);
    assert_eq!(
        named.sessions_file,
        home.join(".reverie-betax/mux-sessions.json")
    );
    assert_eq!(named.socket, "reverie-betax");
    // The installed launcher and the image set REVERIE_DATA_DIR; the old script ignored it.
    let installed = Instance::resolve(
        &env(&[("REVERIE_DATA_DIR", "/instances/default/console")]),
        home,
    );
    assert_eq!(
        installed.sessions_file,
        Path::new("/instances/default/console/mux-sessions.json")
    );
    let socket = Instance::resolve(&env(&[("REVERIE_TMUX_SOCKET", "custom.sock")]), home);
    assert_eq!(socket.socket, "custom.sock");
    let unsafe_socket = Instance::resolve(&env(&[("REVERIE_TMUX_SOCKET", "a b;c")]), home);
    assert_eq!(unsafe_socket.socket, "reverie");
    assert_eq!(plain.own_pane, None);
    let inside = Instance::resolve(
        &env(&[("TMUX", "/sockets/reverie,42,0"), ("TMUX_PANE", "%7")]),
        home,
    );
    assert_eq!(inside.own_pane.as_deref(), Some("%7"));
    let elsewhere = Instance::resolve(
        &env(&[("TMUX", "/sockets/default,42,0"), ("TMUX_PANE", "%7")]),
        home,
    );
    assert_eq!(elsewhere.own_pane, None);
}

#[test]
fn list_and_info_show_each_session_and_whether_it_is_alive() {
    let scratch = Scratch::new("list");
    let instance = instance(&scratch.0, &[record(1, 4001), record(2, 4002)]);
    let sessions = Sessions::load(&instance.sessions_file).unwrap();
    let mut host = Fake {
        alive: ["reverie-1".to_owned()].into(),
        ..Fake::default()
    };
    let table = list(&mut host, &instance, &sessions).unwrap();
    assert!(table.contains(&instance.sessions_file.display().to_string()));
    let rows: Vec<&str> = table.lines().filter(|line| line.starts_with('[')).collect();
    assert_eq!(rows.len(), 2);
    assert!(
        rows[0].starts_with("[1]") && rows[0].contains("session 1") && rows[0].contains("1h 1m")
    );
    assert!(rows[0].contains("alive") && rows[1].contains("dead"));
    assert!(host.calls.iter().all(|call| !call.starts_with("signal")));
    let details = info(&mut host, &instance, &sessions.session(0)).unwrap();
    for expected in [
        "Session ID:  id-1",
        "Tmux:        reverie-1",
        "PID:         4001",
        "Directory:   /work/1",
    ] {
        assert!(details.contains(expected), "{expected} in {details}");
    }
    assert!(details.contains("Status:      alive") && details.contains("Memory:      2.0 MB"));
    assert!(
        info(&mut host, &instance, &sessions.session(1))
            .unwrap()
            .contains("Status:      dead")
    );
    let empty = Scratch::new("empty");
    let none = Instance {
        sessions_file: empty.0.join("mux-sessions.json"),
        socket: "reverie".into(),
        own_pane: None,
    };
    let loaded = Sessions::load(&none.sessions_file).unwrap();
    assert!(
        list(&mut host, &none, &loaded)
            .unwrap()
            .starts_with("No reverie sessions found")
    );
}

#[test]
fn kill_stops_the_selected_sessions_and_keeps_every_other_record_whole() {
    let scratch = Scratch::new("kill");
    let records = [
        record(1, 4001),
        record(2, 4002),
        record(3, 4003),
        record(4, 4004),
    ];
    let instance = instance(&scratch.0, &records);
    let mut sessions = Sessions::load(&instance.sessions_file).unwrap();
    let mut host = Fake {
        alive: ["reverie-2".to_owned(), "reverie-4".to_owned()].into(),
        children: vec![5001],
        ..Fake::default()
    };
    let report = kill(
        &mut host,
        &instance,
        &mut sessions,
        &parse_selection("4,2", 4).unwrap(),
    )
    .unwrap();
    assert_eq!(report.len(), 2);
    assert_eq!(
        on_disk(&instance),
        vec![records[0].clone(), records[2].clone()]
    );
    let session_two: Vec<&String> = host
        .calls
        .iter()
        .skip_while(|call| !call.contains("4002"))
        .take(5)
        .collect();
    assert_eq!(
        session_two,
        [
            "children 4002",
            "signal Process(5001) Term",
            "signal Group(4002) Term",
            "tmux -L reverie-zorblat kill-session -t reverie-2",
            "signal Process(4002) Kill",
        ]
    );
    assert!(!host.alive.contains("reverie-4"));
}

#[test]
fn a_range_and_kill_all_spare_the_session_the_tool_runs_inside() {
    let scratch = Scratch::new("range");
    let records = [record(1, 4001), record(2, 4002), record(3, 4003)];
    let mut instance = instance(&scratch.0, &records);
    instance.own_pane = Some("%7".into());
    let mut sessions = Sessions::load(&instance.sessions_file).unwrap();
    let mut host = Fake {
        own: Some("reverie-2\n".into()),
        ..Fake::default()
    };
    let report = kill(
        &mut host,
        &instance,
        &mut sessions,
        &parse_selection("1-2", 3).unwrap(),
    )
    .unwrap();
    assert_eq!(report[1], "SKIPPED: own tmux session reverie-2");
    assert_eq!(
        on_disk(&instance),
        vec![records[1].clone(), records[2].clone()]
    );
    let all: Vec<usize> = (0..sessions.len()).collect();
    let report = kill(&mut host, &instance, &mut sessions, &all).unwrap();
    assert_eq!(
        report
            .iter()
            .filter(|line| line.starts_with("Killed"))
            .count(),
        1
    );
    assert_eq!(on_disk(&instance), vec![records[1].clone()]);
    assert!(
        !host
            .calls
            .iter()
            .any(|call| call.contains("kill-session -t reverie-2"))
    );
}

#[test]
fn outside_tmux_nothing_counts_as_the_tools_own_session() {
    // The end-to-end run caught this: untargeted, tmux named reverie-1 and kill-all skipped it.
    let scratch = Scratch::new("outside");
    let records = [record(1, 4001), record(2, 4002)];
    let instance = instance(&scratch.0, &records);
    let mut sessions = Sessions::load(&instance.sessions_file).unwrap();
    let mut host = Fake {
        own: Some("reverie-1".into()),
        ..Fake::default()
    };
    let report = kill(&mut host, &instance, &mut sessions, &[0, 1]).unwrap();
    assert!(
        report.iter().all(|line| line.starts_with("Killed")),
        "{report:?}"
    );
    assert!(on_disk(&instance).is_empty());
    assert!(
        !host
            .calls
            .iter()
            .any(|call| call.contains("display-message"))
    );
}

#[test]
fn a_missing_tmux_refuses_before_any_record_or_process_is_touched() {
    let scratch = Scratch::new("no-tmux");
    let records = [record(1, 4001), record(2, 4002)];
    let instance = instance(&scratch.0, &records);
    let before = fs::read_to_string(&instance.sessions_file).unwrap();
    let mut sessions = Sessions::load(&instance.sessions_file).unwrap();
    let mut host = Fake {
        tmux_missing: true,
        ..Fake::default()
    };
    let refused = kill(&mut host, &instance, &mut sessions, &[0, 1]).unwrap_err();
    assert!(refused.0.contains("tmux is not available"), "{refused}");
    assert_eq!(fs::read_to_string(&instance.sessions_file).unwrap(), before);
    assert_eq!(host.calls, ["tmux -V"]);
}

#[test]
fn a_tmux_that_breaks_after_the_check_keeps_the_record_and_fails() {
    // tmux passes -V, then cannot be run: the session may still exist, so nothing is dropped.
    let scratch = Scratch::new("breaks");
    let records = [record(1, 4001), record(2, 4002)];
    let instance = instance(&scratch.0, &records);
    let before = fs::read_to_string(&instance.sessions_file).unwrap();
    let mut sessions = Sessions::load(&instance.sessions_file).unwrap();
    let mut host = Fake {
        tmux_breaks: true,
        ..Fake::default()
    };
    let report = kill(&mut host, &instance, &mut sessions, &[0, 1]).unwrap();
    assert_eq!(report.len(), 1, "{report:?}");
    assert!(
        report[0].starts_with("FAILED: [1] session 1 (reverie-1): tmux could not be run"),
        "{report:?}"
    );
    assert_eq!(fs::read_to_string(&instance.sessions_file).unwrap(), before);
    assert!(
        !host
            .calls
            .iter()
            .any(|call| call.contains("reverie-2") || call.contains("4002")),
        "{:?}",
        host.calls
    );
    // Inside a session, the own-session lookup itself fails first, before any signal.
    let mut inside = instance.clone();
    inside.own_pane = Some("%7".into());
    let mut host = Fake {
        tmux_breaks: true,
        ..Fake::default()
    };
    assert!(kill(&mut host, &inside, &mut sessions, &[0, 1]).is_err());
    assert!(!host.calls.iter().any(|call| call.starts_with("signal")));
    assert_eq!(fs::read_to_string(&instance.sessions_file).unwrap(), before);
    // list and info refuse instead of calling every session dead.
    assert!(list(&mut host, &instance, &sessions).is_err());
    assert!(info(&mut host, &instance, &sessions.session(0)).is_err());
}

#[test]
fn cleanup_works_without_the_console_and_never_signals_a_bad_pid() {
    let scratch = Scratch::new("cleanup");
    // No tmux server answers (nothing alive), and two records carry pids that must not be signalled.
    let records = [
        record(1, 0),
        record(2, 1),
        serde_json::json!({"sessionId": "id-3", "muxName": "reverie-3"}),
    ];
    let instance = instance(&scratch.0, &records);
    let mut sessions = Sessions::load(&instance.sessions_file).unwrap();
    let mut host = Fake::default();
    let report = kill(&mut host, &instance, &mut sessions, &[0, 1, 2]).unwrap();
    assert_eq!(report.len(), 3);
    assert!(on_disk(&instance).is_empty());
    assert!(
        host.calls
            .iter()
            .all(|call| !call.starts_with("signal") && !call.starts_with("children")),
        "{:?}",
        host.calls
    );
    assert_eq!(
        host.calls
            .iter()
            .filter(|call| call.contains("kill-session"))
            .count(),
        3
    );
}

#[test]
fn selections_are_one_based_checked_and_ordered() {
    assert_eq!(parse_selection("2", 3).unwrap(), [1]);
    assert_eq!(parse_selection("3,1,3", 3).unwrap(), [0, 2]);
    assert_eq!(parse_selection("2-3", 3).unwrap(), [1, 2]);
    for bad in ["0", "4", "3-1", "x", "1,,2", "", "-2"] {
        assert!(parse_selection(bad, 3).is_err(), "{bad}");
    }
    assert_eq!(format_duration(45), "45s");
    assert_eq!(format_duration(90), "1m");
    assert_eq!(format_duration(3700), "1h 1m");
    assert_eq!(format_duration(90_000), "1d 1h");
}

#[test]
fn an_unreadable_session_file_refuses_and_is_left_alone() {
    let scratch = Scratch::new("bad");
    let file = scratch.0.join("mux-sessions.json");
    fs::write(&file, "{\"not\": \"a list\"}").unwrap();
    assert!(Sessions::load(&file).is_err());
    fs::write(&file, "not json").unwrap();
    assert!(Sessions::load(&file).is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), "not json");
}
