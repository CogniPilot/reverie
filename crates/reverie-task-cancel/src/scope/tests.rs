use super::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

const UNIT: &str = "reverie-task-cancel-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.scope";
static NEXT: AtomicU64 = AtomicU64::new(0);
static FAKE: OnceLock<PathBuf> = OnceLock::new();

fn props() -> Properties {
    [
        ("Id", UNIT.to_owned()),
        ("InvocationID", "b".repeat(32)),
        ("ControlGroup", format!("/user.slice/{UNIT}")),
        ("ActiveState", "active".to_owned()),
        ("LoadState", "loaded".to_owned()),
        ("RuntimeMaxUSec", "2min".to_owned()),
        ("TimeoutStopUSec", "30s".to_owned()),
        ("MemoryMax", MEMORY.to_string()),
        ("MemorySwapMax", "0".to_owned()),
        ("TasksMax", TASKS.to_string()),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}
fn with(changes: &[(&str, &str)]) -> Properties {
    let mut value = props();
    for (key, changed) in changes {
        value.insert((*key).to_owned(), (*changed).to_owned());
    }
    value
}
fn show(value: &Properties) -> String {
    value
        .iter()
        .map(|(key, value)| format!("{key}={value}\n"))
        .collect()
}

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "task-cancel-scope-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&dir).unwrap();
    dir
}
fn fake() -> &'static Path {
    FAKE.get_or_init(|| {
        let dir = scratch();
        let source = dir.join("fake_systemctl.rs");
        fs::write(
            &source,
            include_str!("../../tests/support/fake_systemctl.rs"),
        )
        .unwrap();
        let binary = dir.join("fake");
        assert!(
            Command::new("rustc")
                .args(["--edition=2024", "-o"])
                .arg(&binary)
                .arg(&source)
                .status()
                .unwrap()
                .success()
        );
        binary
    })
}
/// A tool directory holding its own copy of the fake systemctl; the other tools share one
/// directory of their own.
struct Bus {
    dir: PathBuf,
    tools: Tools,
}
impl Bus {
    fn new() -> Self {
        let dir = scratch();
        let systemctl = dir.join("bin/systemctl");
        fs::create_dir_all(systemctl.parent().unwrap()).unwrap();
        fs::copy(fake(), &systemctl).unwrap();
        fs::set_permissions(&systemctl, fs::Permissions::from_mode(0o755)).unwrap();
        let mut tools = Map::new();
        for name in TOOLS {
            let path = if name == "systemctl" {
                systemctl.clone()
            } else {
                dir.join("other").join(name)
            };
            tools.insert(name.to_owned(), json!(path));
        }
        let tools = Tools::from_pins(&Map::from_iter([(
            "tools".to_owned(),
            Value::Object(tools),
        )]))
        .unwrap();
        Self { dir, tools }
    }
    fn set(&self, name: &str, text: &str) {
        fs::write(self.dir.join("bin").join(name), text).unwrap();
    }
    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.dir.join("bin/calls"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}
fn later(seconds: u64) -> Instant {
    Instant::now() + Duration::from_secs(seconds)
}

#[test]
fn scope_times_are_exact_systemd_spans() {
    let seconds = |n: u128| Some(n * 1_000_000_000);
    assert_eq!(time_value("2min").unwrap(), seconds(120));
    assert_eq!(time_value("30s").unwrap(), seconds(30));
    assert_eq!(time_value("1min 30s").unwrap(), seconds(90));
    assert_eq!(time_value("1.5s").unwrap(), Some(1_500_000_000));
    assert_eq!(time_value("500ms").unwrap(), Some(500_000_000));
    assert_eq!(time_value("1h").unwrap(), seconds(3600));
    // Well formed, but never a pinned whole-nanosecond value.
    assert_eq!(time_value("1.0000000001s").unwrap(), None);
    assert!(time_value(&"9".repeat(60)).is_err());
    assert_eq!(time_value(&format!("{}h", "9".repeat(50))).unwrap(), None);
    for bad in [
        "", "infinity", "1 min", "2m", "1s2", "1..5s", ".5s", "s", "1.s", "-1s",
    ] {
        assert!(time_value(bad).is_err(), "{bad:?}");
    }
    assert_eq!(
        time_value(&"1s".repeat(33)).unwrap_err(),
        "finite scope time required"
    );
}

#[test]
fn show_output_has_one_value_per_key() {
    assert_eq!(
        parse_properties(b"Id=x\nActiveState=active\n").unwrap()["Id"],
        "x"
    );
    assert_eq!(parse_properties(b"").unwrap(), Properties::new());
    assert_eq!(
        parse_properties(b"Id=x\nId=y\n").unwrap_err(),
        "invalid scope properties"
    );
    assert_eq!(
        parse_properties(b"Id\n").unwrap_err(),
        "invalid scope properties"
    );
    assert_eq!(
        parse_properties(&[0xff]).unwrap_err(),
        "invalid scope properties"
    );
}

#[test]
fn actual_lifetime_and_resource_properties_are_mandatory() {
    let binding = capture_scope(&props(), UNIT).unwrap();
    assert_eq!(binding.invocation_id, "b".repeat(32));
    assert_eq!(binding.control_group, format!("/user.slice/{UNIT}"));
    for (key, value, message) in [
        ("InvocationID", "", "actual active scope missing"),
        ("ActiveState", "activating", "actual active scope missing"),
        ("Id", "reverie-task-cancel-other.scope", "wrong own scope"),
        (
            "ControlGroup",
            "/user.slice/other.scope",
            "wrong actual cgroup",
        ),
        ("ControlGroup", "user.slice/x", "wrong actual cgroup"),
        ("RuntimeMaxUSec", "infinity", "unsupported scope time"),
        (
            "RuntimeMaxUSec",
            "3min",
            "independent scope lifetime differs",
        ),
        (
            "TimeoutStopUSec",
            "90s",
            "independent scope lifetime differs",
        ),
        ("MemorySwapMax", "1", "scope resource limits differ"),
        ("MemoryMax", "max", "scope resource limits differ"),
        ("TasksMax", "129", "scope resource limits differ"),
    ] {
        assert_eq!(
            capture_scope(&with(&[(key, value)]), UNIT).unwrap_err(),
            message,
            "{key}={value}"
        );
    }
    let parent = format!("/user.slice/../{UNIT}");
    assert_eq!(
        capture_scope(&with(&[("ControlGroup", parent.as_str())]), UNIT).unwrap_err(),
        "wrong actual cgroup"
    );
    let other = "reverie-task-cancel-zorblat.scope";
    assert_eq!(
        capture_scope(&with(&[("Id", other)]), other).unwrap_err(),
        "wrong own scope"
    );
    assert!(capture_scope(&with(&[("RuntimeMaxUSec", "1min 60s")]), UNIT).is_ok());
}

#[test]
fn inactive_gc_requires_the_previous_exact_active_binding() {
    let binding = capture_scope(&props(), UNIT).unwrap();
    assert!(same_scope(&props(), &binding));
    assert!(same_scope(&with(&[("ControlGroup", "")]), &binding));
    assert!(!same_scope(
        &with(&[("InvocationID", "c".repeat(32).as_str())]),
        &binding
    ));
    assert!(!terminal_scope(&props(), &binding));
    assert!(terminal_scope(
        &with(&[("ActiveState", "inactive")]),
        &binding
    ));
    assert!(terminal_scope(
        &with(&[("ActiveState", "failed"), ("ControlGroup", "")]),
        &binding
    ));
    let unloaded = with(&[
        ("LoadState", "not-found"),
        ("ActiveState", "inactive"),
        ("InvocationID", ""),
        ("ControlGroup", ""),
    ]);
    assert!(terminal_scope(&unloaded, &binding));
    assert!(!terminal_scope(
        &with(&[
            ("ActiveState", "failed"),
            ("InvocationID", "c".repeat(32).as_str())
        ]),
        &binding
    ));
    assert!(!terminal_scope(
        &with(&[
            ("LoadState", "not-found"),
            ("ActiveState", "inactive"),
            ("InvocationID", "")
        ]),
        &binding
    ));
    // Unloaded means no invocation at all: another invocation of the unit is never ours.
    let other = "c".repeat(32);
    let other = with(&[
        ("LoadState", "not-found"),
        ("ActiveState", "inactive"),
        ("InvocationID", other.as_str()),
        ("ControlGroup", ""),
    ]);
    assert!(!terminal_scope(&other, &binding));
}

#[test]
fn an_empty_cgroup_is_populated_0_or_gone() {
    let root = scratch();
    let group = "/user.slice/x.scope";
    assert!(cgroup_empty(&root, group).unwrap(), "gone");
    let dir = root.join("user.slice/x.scope");
    fs::create_dir_all(&dir).unwrap();
    assert!(
        !cgroup_empty(&root, group).unwrap(),
        "present without events"
    );
    fs::write(dir.join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
    assert!(!cgroup_empty(&root, group).unwrap());
    fs::write(dir.join("cgroup.events"), "populated 0\nfrozen 0\n").unwrap();
    assert!(cgroup_empty(&root, group).unwrap());
    fs::write(dir.join("cgroup.events"), "frozen 0\n").unwrap();
    assert!(!cgroup_empty(&root, group).unwrap(), "no populated line");
    fs::write(dir.join("cgroup.events"), "populated\n").unwrap();
    assert_eq!(
        cgroup_empty(&root, group).unwrap_err(),
        "invalid cgroup events"
    );
}

#[test]
fn query_uses_the_remaining_budget_and_a_clean_bus_environment() {
    let bus = Bus::new();
    bus.set("show", &show(&props()));
    let (code, value) = query(&bus.tools, UNIT, later(10)).unwrap();
    assert_eq!((code, value), (0, props()));
    assert_eq!(
        bus.calls(),
        [format!("--user show {UNIT} --property={PROPERTIES}")]
    );
    let seen = fs::read_to_string(bus.dir.join("bin/env")).unwrap();
    let path = format!(
        "PATH={}:{}",
        bus.dir.join("other").display(),
        bus.dir.join("bin").display()
    );
    for line in seen.lines() {
        let key = line.split_once('=').unwrap().0;
        assert!(key == "PATH" || BUS_VARIABLES.contains(&key), "{line}");
    }
    assert!(seen.lines().any(|line| line == path), "{seen}");
    // A spent deadline refuses before any tool runs.
    assert_eq!(
        query(&bus.tools, UNIT, Instant::now()).unwrap_err(),
        "absolute outer deadline exhausted"
    );
    assert_eq!(bus.calls().len(), 1);
}

#[test]
fn a_slow_or_oversized_show_is_bounded() {
    let bus = Bus::new();
    bus.set("show.sleep", "5000");
    let started = Instant::now();
    let error = query(
        &bus.tools,
        UNIT,
        Instant::now() + Duration::from_millis(300),
    )
    .unwrap_err();
    assert!(error.ends_with("exceeded its deadline"), "{error}");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    let bus = Bus::new();
    bus.set("show", &"Id=x\n".repeat(4000));
    assert_eq!(
        query(&bus.tools, UNIT, later(10)).unwrap_err(),
        "scope metadata bound"
    );
}

#[test]
fn a_descendant_holding_the_output_open_cannot_outlast_the_deadline() {
    let bus = Bus::new();
    bus.set("show", &show(&props()));
    bus.set("show.linger", "3000");
    let started = Instant::now();
    let error = query(
        &bus.tools,
        UNIT,
        Instant::now() + Duration::from_millis(300),
    )
    .unwrap_err();
    assert!(error.ends_with("exceeded its deadline"), "{error}");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_child_that_closes_its_output_but_keeps_running_is_killed_at_the_deadline() {
    let bus = Bus::new();
    bus.set("show", &show(&props()));
    bus.set("show.hold", "3000");
    let started = Instant::now();
    let error = query(
        &bus.tools,
        UNIT,
        Instant::now() + Duration::from_millis(300),
    )
    .unwrap_err();
    assert!(error.ends_with("exceeded its deadline"), "{error}");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn a_rebound_scope_cannot_receive_stop() {
    let bus = Bus::new();
    let binding = capture_scope(&props(), UNIT).unwrap();
    bus.set(
        "show",
        &show(&with(&[("InvocationID", "c".repeat(32).as_str())])),
    );
    assert_eq!(
        stop_owned_scope(&bus.tools, UNIT, &binding, later(10)).unwrap_err(),
        "unit changed before owned stop"
    );
    assert_eq!(bus.calls().len(), 1, "no stop after a rebound show");
    bus.set("show", &show(&props()));
    stop_owned_scope(&bus.tools, UNIT, &binding, later(10)).unwrap();
    assert_eq!(bus.calls()[2], format!("--user stop {UNIT}"));
    bus.set("stop.code", "1");
    assert_eq!(
        stop_owned_scope(&bus.tools, UNIT, &binding, later(10)).unwrap_err(),
        "owned scope stop failed"
    );
}

#[test]
fn stop_waits_are_capped_by_the_same_absolute_deadline() {
    assert_eq!(
        remaining(Instant::now(), STOP).unwrap_err(),
        "absolute outer deadline exhausted"
    );
    assert!(remaining(later(1), STOP + QUERY).unwrap() <= Duration::from_secs(1));
    assert_eq!(remaining(later(600), QUERY).unwrap(), QUERY);
    assert_eq!(TOTAL, Duration::from_secs(180));
}

#[test]
fn the_scope_command_is_fixed() {
    let bus = Bus::new();
    let launch = Launch {
        unit: UNIT,
        cpus: &[0, 3],
        source: Path::new("/src"),
        task: Path::new("/tasks/t1"),
        pins: Path::new("/private/pins.json"),
        pins_sha256: "p",
        attempt_sha256: "a",
    };
    let tool = |name: &str| bus.tools.get(name).display().to_string();
    let expected = [
        tool("systemd-run"),
        "--user".into(),
        "--scope".into(),
        "--unit".into(),
        UNIT.into(),
        "--property=RuntimeMaxSec=120".into(),
        "--property=TimeoutStopSec=30".into(),
        "--property=MemoryMax=536870912".into(),
        "--property=MemorySwapMax=0".into(),
        "--property=TasksMax=128".into(),
        tool("taskset"),
        "-c".into(),
        "0,3".into(),
        tool("python"),
        "-I".into(),
        "-B".into(),
        "/src/scripts/acceptance/task-cancel-native.py".into(),
        "--run-owned-fixture".into(),
        "--lease-root".into(),
        "/tasks/t1".into(),
        "--pins".into(),
        "/private/pins.json".into(),
        "--pins-sha256".into(),
        "p".into(),
        "--outer-attempt-sha256".into(),
        "a".into(),
    ];
    let actual: Vec<String> = scope_command(&bus.tools, &launch)
        .iter()
        .map(|part| part.to_string_lossy().into_owned())
        .collect();
    assert_eq!(actual, expected);
    assert!(own_unit(UNIT));
    assert!(!own_unit(
        "reverie-task-cancel-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.scope"
    ));
}
