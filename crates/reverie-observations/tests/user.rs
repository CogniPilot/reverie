//! The USER observation scenarios of `tests/test_resource_history.py` on a
//! synthetic owner home, with systemd replaced by a recording fake (the
//! Python tests patched the same seams), plus the previous-release paths.
use reverie_observations::Owner;
use reverie_observations::Refused;
use reverie_observations::user::{Action, Context, Shown, Stop, Systemd, hex, registration};
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

static NEXT: AtomicU64 = AtomicU64::new(0);
const ENTRY: &str = "/nix/store/test-entry/bin/reverie-observations";
fn digest(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

const PYTHON: &str = "/nix/store/test-python3/bin/python3";
const PYTHON_ENTRY: &str = "/nix/store/test-observations/libexec/reverie/collector_user.py";

/// systemd as the Python tests' patched `unit_metadata` saw it: a unit is
/// loaded exactly when its file exists. Controls are recorded.
struct Fake {
    units: PathBuf,
    group: String,
    calls: Vec<Vec<String>>,
}

impl Systemd for Fake {
    fn entry(&self) -> Result<String, Refused> {
        Ok(ENTRY.into())
    }
    fn show(&mut self, args: &[&str]) -> Result<Shown, Refused> {
        if args.contains(&"--property=MainPID,ControlGroup,TimeoutStartUSec,TimeoutStopUSec") {
            let stdout = format!(
                "MainPID={}\nControlGroup={}\nTimeoutStartUSec=1min 30s\nTimeoutStopUSec=5s\n",
                std::process::id(),
                self.group
            );
            return Ok(Shown { status: 0, stdout });
        }
        let target = self.units.join(args[0]);
        let stdout = if target.exists() {
            format!(
                "LoadState=loaded\nFragmentPath={}\nDropInPaths=\n",
                target.display()
            )
        } else {
            "LoadState=not-found\nFragmentPath=\nDropInPaths=\n".to_owned()
        };
        Ok(Shown { status: 0, stdout })
    }
    fn control(&mut self, args: &[&str], _: Duration) -> Result<(), Refused> {
        self.calls
            .push(args.iter().map(|arg| (*arg).to_owned()).collect());
        Ok(())
    }
}

struct Home {
    root: PathBuf,
    home: PathBuf,
    config: PathBuf,
    owner: Owner,
}

fn private(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

/// A private owner file with exactly `text`.
fn put(path: &Path, text: &str) {
    fs::write(path, text).unwrap();
    private(path, 0o600);
}

/// `path` with `.migrate` appended: a staged migration file.
fn staged(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.migrate", path.display()))
}

impl Home {
    fn new() -> Self {
        Self::at("reverie/observations")
    }
    /// A home whose configuration lives in `directory`.
    fn at(directory: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "user-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("home")).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let home = root.join("home");
        private(&home, 0o755);
        let config = home.join(directory).join("config.json");
        let owner = Owner::new(&home).unwrap();
        Self {
            root,
            home,
            config,
            owner,
        }
    }
    fn fake(&self) -> Fake {
        Fake {
            units: self.home.join(".config/systemd/user"),
            group: "/user.slice/test.service".into(),
            calls: Vec::new(),
        }
    }
    fn act(&self, fake: &mut Fake, action: Action) -> Result<i32, Stop> {
        let mut context = Context {
            owner: &self.owner,
            home: self.home.clone(),
            systemd: fake,
            proc_cgroup: self.root.join("cgroup-self"),
            cgroup_root: self.root.join("cgroup"),
        };
        context.act(&self.config, action)
    }
    fn state(&self) -> PathBuf {
        self.config.with_file_name("history")
    }
    fn unit(&self, suffix: &str) -> PathBuf {
        self.home.join(format!(
            ".config/systemd/user/reverie-observations.{suffix}"
        ))
    }
    /// The kernel budget files of the fake unit's cgroup.
    fn budget(&self, memory: &str) {
        fs::write(
            self.root.join("cgroup-self"),
            "0::/user.slice/test.service\n",
        )
        .unwrap();
        let group = self.root.join("cgroup/user.slice/test.service");
        fs::create_dir_all(&group).unwrap();
        for (name, value) in [
            ("memory.max", memory),
            ("memory.swap.max", "0"),
            ("pids.max", "32"),
            ("cpu.max", "50000 100000"),
        ] {
            fs::write(group.join(name), format!("{value}\n")).unwrap();
        }
    }
    fn record(&self) -> PathBuf {
        self.config.with_file_name(".observations-units.json")
    }
    /// The units and record this release's `install` writes.
    fn current_release(&self) -> (String, String) {
        let config = self.config.to_str().unwrap();
        let (service, timer) = reverie_observations::user::unit_text(
            &[ENTRY, "--config", config, "sample"],
            self.state().to_str().unwrap(),
            300,
        );
        let record = registration(config, &digest(&service), &digest(&timer));
        (service, record)
    }
    /// Units and registration as the previous Python `install` wrote them.
    fn install_previous_release(&self) {
        let config = self.config.to_str().unwrap();
        let exec = [
            PYTHON,
            "-I",
            "-B",
            PYTHON_ENTRY,
            "--config",
            config,
            "sample",
        ];
        let state = self.state();
        let (service, timer) =
            reverie_observations::user::unit_text(&exec, state.to_str().unwrap(), 300);
        fs::create_dir_all(self.unit("service").parent().unwrap()).unwrap();
        private(&self.home.join(".config"), 0o700);
        for (suffix, text) in [("service", &service), ("timer", &timer)] {
            fs::write(self.unit(suffix), text).unwrap();
            private(&self.unit(suffix), 0o600);
        }
        let record = registration(config, &digest(&service), &digest(&timer));
        put(&self.record(), &record);
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn distinct_marker_no_root_adoption_and_idempotent_init_preserves_history() {
    let home = Home::new();
    let mut fake = home.fake();
    assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
    let config = fs::read_to_string(&home.config).unwrap();
    assert!(config.starts_with(
        "{\n  \"version\": 1,\n  \"mode\": \"user-observations\",\n  \"stateDirectory\": \""
    ));
    let sample = home.state().join("samples-2026-10-25.jsonl");
    fs::write(&sample, "{}\n").unwrap();
    private(&sample, 0o600);
    assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
    assert_eq!(fs::read_to_string(&sample).unwrap(), "{}\n");
    assert_eq!(fs::read_to_string(&home.config).unwrap(), config);
    fs::remove_file(home.state().join(".reverie-user-observations.json")).unwrap();
    fs::write(
        home.state().join(".reverie-collector-state.json"),
        "root-marker",
    )
    .unwrap();
    assert!(matches!(
        home.act(&mut fake, Action::Init),
        Err(Stop::Refused(_))
    ));
    assert_eq!(fs::read_to_string(&sample).unwrap(), "{}\n");
}

#[test]
fn fixed_units_are_disabled_until_explicit_control_and_install_registers_exact_bytes() {
    let home = Home::new();
    let mut fake = home.fake();
    assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
    assert_eq!(home.act(&mut fake, Action::Install), Ok(0));
    assert_eq!(fake.calls, [vec!["daemon-reload".to_owned()]]);
    let service = fs::read_to_string(home.unit("service")).unwrap();
    assert!(service.contains(&format!(
        "ExecStart=\"{ENTRY}\" \"--config\" \"{}\" \"sample\"",
        home.config.display()
    )));
    assert_eq!(
        fs::read_to_string(home.unit("timer"))
            .unwrap()
            .lines()
            .nth(3),
        Some("OnBootSec=300")
    );
    // A second install with the same record is idempotent.
    assert_eq!(home.act(&mut fake, Action::Install), Ok(0));
    assert_eq!(home.act(&mut fake, Action::Start), Ok(0));
    assert_eq!(
        fake.calls.last().unwrap(),
        &["start", "reverie-observations.service"]
    );
}

#[test]
fn previous_release_units_allow_stop_disable_and_status() {
    let home = Home::new();
    let mut fake = home.fake();
    assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
    home.install_previous_release();
    assert_eq!(home.act(&mut fake, Action::Stop), Ok(0));
    assert_eq!(home.act(&mut fake, Action::Disable), Ok(0));
    assert_eq!(home.act(&mut fake, Action::Status), Ok(0));
    let commands = fake
        .calls
        .iter()
        .map(|call| call[0].as_str())
        .collect::<Vec<_>>();
    assert_eq!(commands, ["stop", "disable", "show"]);
}

#[test]
fn previous_release_units_refuse_start_and_enable_with_reinstall() {
    let home = Home::new();
    let mut fake = home.fake();
    assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
    home.install_previous_release();
    assert_eq!(
        home.act(&mut fake, Action::Start),
        Err(Stop::PreviousRelease)
    );
    assert_eq!(
        home.act(&mut fake, Action::Enable),
        Err(Stop::PreviousRelease)
    );
    assert!(fake.calls.is_empty());
}

#[test]
fn install_migrates_only_exact_previous_release_units() {
    let home = Home::new();
    let mut fake = home.fake();
    assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
    home.install_previous_release();
    assert_eq!(home.act(&mut fake, Action::Install), Ok(0));
    assert!(
        fs::read_to_string(home.unit("service"))
            .unwrap()
            .contains(ENTRY)
    );
    assert_eq!(home.act(&mut fake, Action::Start), Ok(0));
    // Previous-release bytes with one byte changed (and the digest re-recorded)
    // are someone else's units: never replaced.
    let other = Home::new();
    let mut fake = other.fake();
    assert_eq!(other.act(&mut fake, Action::Init), Ok(0));
    other.install_previous_release();
    let service = fs::read_to_string(other.unit("service"))
        .unwrap()
        .replace("Nice=19", "Nice=18");
    let timer = fs::read_to_string(other.unit("timer")).unwrap();
    fs::write(other.unit("service"), &service).unwrap();
    let record = registration(
        other.config.to_str().unwrap(),
        &digest(&service),
        &digest(&timer),
    );
    fs::write(
        other
            .home
            .join("reverie/observations/.observations-units.json"),
        record,
    )
    .unwrap();
    assert!(matches!(
        other.act(&mut fake, Action::Install),
        Err(Stop::Refused(_))
    ));
    assert_eq!(fs::read_to_string(other.unit("service")).unwrap(), service);
    assert!(matches!(
        other.act(&mut fake, Action::Start),
        Err(Stop::Refused(_))
    ));
}

#[test]
fn previous_release_units_with_a_quoted_configuration_path_are_recognized() {
    let home = Home::at("reverie/with space 50%$");
    let mut fake = home.fake();
    assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
    home.install_previous_release();
    assert_eq!(
        home.act(&mut fake, Action::Start),
        Err(Stop::PreviousRelease)
    );
    assert_eq!(
        home.act(&mut fake, Action::Enable),
        Err(Stop::PreviousRelease)
    );
    assert_eq!(home.act(&mut fake, Action::Install), Ok(0));
    assert_eq!(home.act(&mut fake, Action::Start), Ok(0));
}

/// Each point a migration can stop at: the record staged, then the service
/// staged, then the service published with the record still staged.
#[test]
fn an_interrupted_migration_keeps_registered_control_and_install_completes_it() {
    for published in 0..3 {
        let home = Home::new();
        let mut fake = home.fake();
        assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
        home.install_previous_release();
        let (service, record) = home.current_release();
        put(&staged(&home.record()), &record);
        if published >= 1 {
            put(&staged(&home.unit("service")), &service);
        }
        if published == 2 {
            fs::rename(staged(&home.unit("service")), home.unit("service")).unwrap();
        }
        for action in [Action::Stop, Action::Disable, Action::Status] {
            assert_eq!(home.act(&mut fake, action), Ok(0), "{published} {action:?}");
        }
        // Start needs a settled record: the previous release's, or install's.
        assert!(home.act(&mut fake, Action::Start).is_err(), "{published}");
        assert_eq!(home.act(&mut fake, Action::Install), Ok(0), "{published}");
        assert_eq!(fs::read_to_string(home.record()).unwrap(), record);
        assert_eq!(fs::read_to_string(home.unit("service")).unwrap(), service);
        assert!(!staged(&home.record()).exists() && !staged(&home.unit("service")).exists());
        assert_eq!(home.act(&mut fake, Action::Start), Ok(0), "{published}");
    }
}

#[test]
fn a_refused_staging_write_leaves_the_previous_installation_intact() {
    for foreign in ["service", "record"] {
        let home = Home::new();
        let mut fake = home.fake();
        assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
        home.install_previous_release();
        let before = (
            fs::read(home.unit("service")).unwrap(),
            fs::read(home.record()).unwrap(),
        );
        let file = staged(&if foreign == "service" {
            home.unit("service")
        } else {
            home.record()
        });
        put(&file, "someone else's file\n");
        assert!(
            matches!(home.act(&mut fake, Action::Install), Err(Stop::Refused(_))),
            "{foreign}"
        );
        let after = (
            fs::read(home.unit("service")).unwrap(),
            fs::read(home.record()).unwrap(),
        );
        assert_eq!(before, after, "{foreign}");
        assert_eq!(home.act(&mut fake, Action::Stop), Ok(0), "{foreign}");
        assert_eq!(home.act(&mut fake, Action::Disable), Ok(0), "{foreign}");
        assert_eq!(
            home.act(&mut fake, Action::Start),
            Err(Stop::PreviousRelease)
        );
        // Once the colliding file is gone, install completes the migration.
        fs::remove_file(&file).unwrap();
        assert_eq!(home.act(&mut fake, Action::Install), Ok(0), "{foreign}");
        assert_eq!(home.act(&mut fake, Action::Start), Ok(0), "{foreign}");
    }
    // The timer is never rewritten, so its staged name is not touched.
    let home = Home::new();
    let mut fake = home.fake();
    assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
    home.install_previous_release();
    put(&staged(&home.unit("timer")), "someone else's file\n");
    assert_eq!(home.act(&mut fake, Action::Install), Ok(0));
    assert_eq!(
        fs::read_to_string(staged(&home.unit("timer"))).unwrap(),
        "someone else's file\n"
    );
    assert_eq!(home.act(&mut fake, Action::Start), Ok(0));
}

#[test]
fn missing_actual_service_binding_refuses_before_any_sampler() {
    let home = Home::new();
    let mut fake = home.fake();
    assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
    home.budget("max");
    assert!(matches!(
        home.act(&mut fake, Action::Sample),
        Err(Stop::Refused(_))
    ));
    home.budget(&(256u64 << 20).to_string());
    fake.group = "/user.slice/other.service".into();
    assert!(matches!(
        home.act(&mut fake, Action::Sample),
        Err(Stop::Refused(_))
    ));
    let entries = fs::read_dir(home.state()).unwrap().count();
    assert_eq!(entries, 1, "only the marker: no sampler ran");
}

#[test]
fn user_mode_reuses_the_collector_with_no_prune_source_and_private_persistence() {
    let home = Home::new();
    let mut fake = home.fake();
    assert_eq!(home.act(&mut fake, Action::Init), Ok(0));
    home.budget(&(256u64 << 20).to_string());
    // A start waiting on the unit-control lock must not block the sample entry.
    let lock = fs::File::open(
        home.home
            .join("reverie/observations/.observations-control.lock"),
    )
    .unwrap();
    let _held = nix::fcntl::Flock::lock(lock, nix::fcntl::FlockArg::LockExclusive).unwrap();
    assert_eq!(home.act(&mut fake, Action::Sample), Ok(0));
    for entry in fs::read_dir(home.state()).unwrap() {
        let mode = entry.unwrap().metadata().unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
    }
    assert!(
        !home.state().join("prune-runs.jsonl").exists(),
        "no prune source in USER mode"
    );
    let day = fs::read_dir(home.state())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .find(|name| name.starts_with("samples-"))
        .unwrap();
    let line = fs::read_to_string(home.state().join(day)).unwrap();
    assert!(line.contains("\"label\":\"user-observations\""));
    assert!(line.contains("\"source\":\"off\""));
}

#[test]
fn a_non_canonical_configuration_path_is_an_uncaught_error() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_reverie-observations"))
        .args(["--config", "relative/config.json", "init"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
}
