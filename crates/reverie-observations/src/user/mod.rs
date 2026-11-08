//! `cleanup/collector_user.py`: opt-in USER observations. They never adopt
//! the root collector or grant effects. Sampling goes through the native
//! collector; the fixed user units are controlled through `Systemd`.
mod service;
mod units;

use crate::Refused;
use crate::collector::{Failure, sample_once};
use crate::custody::{Owner, exclusive, make_directories};
use reverie_contracts::collector::{Config, Out, dump};
use reverie_contracts::resource_history::ObservationConfig;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::Duration;
use units::{UNIT, previous_release};
pub use units::{hex, registration, unit_text};

pub(crate) use service::verify_service;

/// The output of `systemctl --user show ...`.
pub struct Shown {
    pub status: i32,
    pub stdout: String,
}

/// The packaged program and its fixed `systemctl`, both checked when used.
pub trait Systemd {
    /// The immutable packaged entry this unit runs.
    fn entry(&self) -> Result<String, Refused>;
    /// `systemctl --user show <args>` with its stdout captured.
    fn show(&mut self, args: &[&str]) -> Result<Shown, Refused>;
    /// `systemctl --user <args>` with inherited output; a nonzero exit refuses.
    fn control(&mut self, args: &[&str], timeout: Duration) -> Result<(), Refused>;
}

/// One command's owner, home and system handles.
pub struct Context<'a> {
    pub owner: &'a Owner,
    pub home: PathBuf,
    pub systemd: &'a mut dyn Systemd,
    pub proc_cgroup: PathBuf,
    pub cgroup_root: PathBuf,
}

/// The actions of `reverie-observations`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Init,
    Install,
    Enable,
    Disable,
    Start,
    Stop,
    Status,
    Sample,
}

/// Why an action did not complete.
#[derive(Debug, Eq, PartialEq)]
pub enum Stop {
    /// Any refusal: exit 2 with the uniform message.
    Refused(Refused),
    /// Units installed by the previous release: re-install required.
    PreviousRelease,
    /// Python's uncaught exception: exit 1.
    Crash(String),
}

impl From<Refused> for Stop {
    fn from(refused: Refused) -> Self {
        Self::Refused(refused)
    }
}

const CONFIG_LIMIT: usize = 16384;
const SAMPLE_FILES: [&str; 5] = [
    ".reverie-user-observations.json",
    ".lock",
    "state.json",
    "state.json.tmp",
    "prune-runs.jsonl",
];

fn text_of(points: &[u32]) -> Result<String, Refused> {
    points
        .iter()
        .map(|point| char::from_u32(*point))
        .collect::<Option<String>>()
        .ok_or(Refused("Observation path is not text"))
}

fn path_text(path: &Path) -> Result<String, Refused> {
    path.to_str()
        .map(str::to_owned)
        .ok_or(Refused("Observation path is not text"))
}

fn json(value: &str) -> String {
    dump(&Out::text(value)).unwrap_or_default()
}

/// `json.dumps(default_cfg, indent=2) + "\n"`.
fn default_config(path: &Path) -> Result<String, Refused> {
    let state = path
        .parent()
        .ok_or(Refused("Configuration needs a parent"))?
        .join("history");
    Ok(format!(
        "{{\n  \"version\": 1,\n  \"mode\": \"user-observations\",\n  \"stateDirectory\": {},\n  \"intervalSeconds\": 300,\n  \"retentionDays\": 30,\n  \"rollupRetentionDays\": 400,\n  \"drives\": {{}},\n  \"gpuExecutable\": null\n}}\n",
        json(&path_text(&state)?)
    ))
}

impl Context<'_> {
    fn units_dir(&self) -> PathBuf {
        self.home.join(".config/systemd/user")
    }
    fn unit_path(&self, suffix: &str) -> PathBuf {
        self.units_dir().join(format!("{UNIT}.{suffix}"))
    }
    fn registered_path(path: &Path) -> PathBuf {
        path.parent()
            .unwrap_or(Path::new("/"))
            .join(".observations-units.json")
    }

    fn init(&mut self, path: &Path) -> Result<(), Stop> {
        make_directories(
            path.parent()
                .ok_or(Refused("Configuration needs a parent"))?,
            0o700,
        )?;
        let text = default_config(path)?;
        let _lock = self.owner.operation(path)?;
        if std::fs::metadata(path).is_err() {
            exclusive(path, text.as_bytes())?;
        }
        let (_, cfg) = self.owner.configuration(path)?;
        self.owner.create_state(&cfg)?;
        Ok(())
    }

    /// `sample(path, cfg)`.
    fn sample(&mut self, path: &Path, raw: &[u8], cfg: &ObservationConfig) -> Result<i32, Stop> {
        verify_service(self.systemd, &self.proc_cgroup, &self.cgroup_root)?;
        let (state, _) = self.owner.state_directory(cfg)?;
        let entries =
            std::fs::read_dir(&state).map_err(|_| Refused("Observation state unavailable"))?;
        for (count, entry) in entries.enumerate() {
            let entry = entry.map_err(|_| Refused("Observation state unavailable"))?;
            if count >= 1024 {
                return Err(Refused("Observation file count exceeded").into());
            }
            let name = entry.file_name();
            let named = name.to_str().is_some_and(|name| {
                SAMPLE_FILES.contains(&name)
                    || reverie_contracts::collector::sample_name(name)
                    || reverie_contracts::collector::retention_end(name)
                        .is_ok_and(|end| end.is_some_and(|(_, rollup)| rollup))
            });
            if !named {
                return Err(Refused("Unexpected file in dedicated observation state").into());
            }
            self.owner.private_bytes(&state.join(&name), 64 << 20)?;
        }
        let before = self.owner.private_bytes(path, CONFIG_LIMIT)?;
        let config = collector_config(&state, cfg)?;
        let previous = nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(0o077));
        let result = sample_once(&config, None);
        nix::sys::stat::umask(previous);
        let code = match result {
            Ok(_) => 0,
            Err(Failure::Busy) => 5,
            Err(Failure::Config(message)) => {
                return Err(Stop::Crash(format!("ConfigError: {message}")));
            }
            Err(Failure::Fatal(_)) => return Err(Refused("Collector sample failed").into()),
        };
        if self.owner.private_bytes(path, CONFIG_LIMIT)? != before || before != raw {
            return Err(Refused("Observation configuration changed").into());
        }
        Ok(code)
    }

    /// `unit_metadata(suffix)`: (LoadState, FragmentPath, DropInPaths).
    fn unit_metadata(&mut self, suffix: &str) -> Result<(String, String, String), Refused> {
        let unavailable = Refused("Unit metadata unavailable");
        let shown = self.systemd.show(&[
            &format!("{UNIT}.{suffix}"),
            "--all",
            "--property=LoadState,FragmentPath,DropInPaths",
        ])?;
        if shown.stdout.len() > 8192 {
            return Err(Refused("Unit metadata bound exceeded"));
        }
        let mut rows = BTreeMap::new();
        for (key, value) in shown.stdout.lines().filter_map(|line| line.split_once('=')) {
            if rows.insert(key.to_owned(), value.to_owned()).is_some() {
                return Err(Refused("Duplicate configuration key"));
            }
        }
        let keys = ["DropInPaths", "FragmentPath", "LoadState"];
        if !rows.keys().map(String::as_str).eq(keys) || ![0, 1, 4].contains(&shown.status) {
            return Err(unavailable);
        }
        let (load, fragment, dropins) = (
            rows["LoadState"].clone(),
            rows["FragmentPath"].clone(),
            rows["DropInPaths"].clone(),
        );
        let absent = load == "not-found" && fragment.is_empty() && dropins.is_empty();
        if !absent && (shown.status != 0 || load != "loaded") {
            return Err(Refused("Unit is not loaded normally"));
        }
        Ok((load, fragment, dropins))
    }

    /// `registered_units(path, allow_absent)`: the bytes of the record the
    /// units match. That is the record, or else the staged record of an
    /// interrupted `migrate`, which only `install` settles.
    fn registered_units(&mut self, path: &Path, allow_absent: bool) -> Result<Vec<u8>, Refused> {
        let record = Self::registered_path(path);
        match self.record_units(&record, path, allow_absent) {
            Err(refused) if std::fs::symlink_metadata(staged(&record)).is_ok() => self
                .record_units(&staged(&record), path, allow_absent)
                .map_err(|_| refused),
            settled => settled,
        }
    }

    /// One record's bytes after its units' bytes and real fragments check.
    fn record_units(
        &mut self,
        record: &Path,
        path: &Path,
        allow_absent: bool,
    ) -> Result<Vec<u8>, Refused> {
        let raw = self.owner.private_bytes(record, CONFIG_LIMIT)?;
        let refused = Refused("Installed unit record refused");
        let record: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| refused)?;
        let digest = |suffix: &str| record["units"][suffix].as_str().map(str::to_owned);
        let (Some(service), Some(timer)) = (digest("service"), digest("timer")) else {
            return Err(refused);
        };
        // Only the exact bytes this tool writes: no other keys, values or layout.
        if registration(&path_text(path)?, &service, &timer).into_bytes() != raw {
            return Err(refused);
        }
        for (suffix, digest) in [("service", service), ("timer", timer)] {
            self.registered_unit(suffix, &digest, allow_absent)?;
        }
        Ok(raw)
    }

    /// One registered unit: its bytes match the digest, and systemd loads
    /// exactly that fragment without drop-ins.
    fn registered_unit(
        &mut self,
        suffix: &str,
        digest: &str,
        allow_absent: bool,
    ) -> Result<(), Refused> {
        let valid = digest.len() == 64
            && digest
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
        if !valid {
            return Err(Refused("Unit digest refused"));
        }
        let target = self.unit_path(suffix);
        let present = std::fs::symlink_metadata(&target).is_ok();
        if present
            && hex(&Sha256::digest(
                self.owner.private_bytes(&target, CONFIG_LIMIT)?,
            )) != digest
        {
            return Err(Refused("Registered unit was modified"));
        }
        if !present && !allow_absent {
            return Err(Refused("Registered unit is missing"));
        }
        let (load, fragment, dropins) = self.unit_metadata(suffix)?;
        if load == "not-found" && allow_absent {
            return Ok(());
        }
        if fragment != path_text(&target)? || !dropins.is_empty() {
            return Err(Refused("Foreign or overridden unit fragment refused"));
        }
        Ok(())
    }

    fn expected(
        &mut self,
        path: &Path,
        cfg: &ObservationConfig,
    ) -> Result<(String, String), Refused> {
        let entry = self.systemd.entry()?;
        let config = path_text(path)?;
        let exec = [entry.as_str(), "--config", config.as_str(), "sample"];
        Ok(unit_text(
            &exec,
            &text_of(&cfg.state_directory)?,
            cfg.interval_seconds,
        ))
    }

    /// The installed units are exactly the previous release's for this config.
    fn previous_units(&self, path: &Path, cfg: &ObservationConfig) -> Result<bool, Refused> {
        let read = |suffix| -> Result<String, Refused> {
            String::from_utf8(
                self.owner
                    .private_bytes(&self.unit_path(suffix), CONFIG_LIMIT)?,
            )
            .map_err(|_| Refused("Unit is not text"))
        };
        let (service, timer) = (read("service")?, read("timer")?);
        Ok(previous_release(
            &service,
            &timer,
            &path_text(path)?,
            &text_of(&cfg.state_directory)?,
            cfg.interval_seconds,
        ))
    }

    /// `require_installed_units(path, cfg)`.
    fn require_installed_units(
        &mut self,
        path: &Path,
        cfg: &ObservationConfig,
    ) -> Result<(), Stop> {
        let (service, timer) = self.expected(path, cfg)?;
        let installed = |suffix| {
            self.owner
                .private_bytes(&self.unit_path(suffix), CONFIG_LIMIT)
        };
        let current =
            installed("service")? == service.as_bytes() && installed("timer")? == timer.as_bytes();
        if current {
            return Ok(());
        }
        if self.previous_units(path, cfg).unwrap_or(false) {
            return Err(Stop::PreviousRelease);
        }
        Err(Refused("Refusing to start a different or modified unit").into())
    }

    /// Replace exactly the previous release's service; its timer already has
    /// the same bytes. The record and service are staged before anything
    /// changes, so a refused write leaves the old installation intact. The
    /// service is published before the record; in between, the staged record
    /// is the one the units match, so stop, disable, status and install work.
    fn migrate(
        &self,
        path: &Path,
        service: &str,
        timer: &str,
        record: &str,
    ) -> Result<(), Refused> {
        let installed = self
            .owner
            .private_bytes(&self.unit_path("timer"), CONFIG_LIMIT)?;
        if installed != timer.as_bytes() {
            return Err(Refused(
                "Existing installation differs; no automatic replacement",
            ));
        }
        let (unit, registered) = (self.unit_path("service"), Self::registered_path(path));
        self.stage(&staged(&registered), record)?;
        self.stage(&staged(&unit), service)?;
        publish(&staged(&unit), &unit)?;
        publish(&staged(&registered), &registered)
    }

    /// A staged file, written exclusively. One an interrupted migration left
    /// is reused only when it already has exactly these bytes.
    fn stage(&self, path: &Path, data: &str) -> Result<(), Refused> {
        if std::fs::symlink_metadata(path).is_err() {
            return exclusive(path, data.as_bytes());
        }
        if self.owner.private_bytes(path, CONFIG_LIMIT)? != data.as_bytes() {
            return Err(Refused("A different staged migration file exists"));
        }
        Ok(())
    }

    /// An existing registration: the same record, or exactly the previous
    /// release's units, which are migrated. Anything else is refused.
    fn reuse_record(
        &mut self,
        path: &Path,
        cfg: &ObservationConfig,
        (service, timer): (&str, &str),
        record: &str,
    ) -> Result<(), Refused> {
        let registered = Self::registered_path(path);
        if self.registered_units(path, true)? == record.as_bytes() {
            // An interrupted migration had already published the service:
            // its staged record, which the units match, becomes the record.
            let pending = staged(&registered);
            if std::fs::symlink_metadata(&pending).is_ok()
                && self.owner.private_bytes(&pending, CONFIG_LIMIT)? == record.as_bytes()
            {
                publish(&pending, &registered)?;
            }
            return Ok(());
        }
        let present = ["service", "timer"]
            .iter()
            .all(|suffix| self.unit_path(suffix).exists());
        if !(present && self.previous_units(path, cfg)?) {
            return Err(Refused(
                "Existing installation differs; no automatic replacement",
            ));
        }
        self.migrate(path, service, timer, record)
    }

    /// A first registration: no same-name unit may exist or be loaded.
    fn first_record(&mut self, path: &Path, record: &str) -> Result<(), Refused> {
        for suffix in ["service", "timer"] {
            let (load, _, _) = self.unit_metadata(suffix)?;
            if std::fs::symlink_metadata(self.unit_path(suffix)).is_ok() || load != "not-found" {
                return Err(Refused("Refusing to adopt a pre-existing same-name unit"));
            }
        }
        // Record only the exact intended files before publication. It cannot
        // authorize a command alone: every control rechecks bytes and fragments.
        exclusive(&Self::registered_path(path), record.as_bytes())
    }

    /// `install_units(path, cfg)`.
    fn install(&mut self, path: &Path, cfg: &ObservationConfig) -> Result<(), Stop> {
        self.owner.ancestry(&self.units_dir().join("unit"))?;
        let (service, timer) = self.expected(path, cfg)?;
        let config = path_text(path)?;
        let record = registration(
            &config,
            &hex(&Sha256::digest(service.as_bytes())),
            &hex(&Sha256::digest(timer.as_bytes())),
        );
        if std::fs::symlink_metadata(Self::registered_path(path)).is_ok() {
            self.reuse_record(path, cfg, (&service, &timer), &record)?;
        } else {
            self.first_record(path, &record)?;
        }
        make_directories(&self.units_dir(), 0o700)?;
        for (suffix, text) in [("service", &service), ("timer", &timer)] {
            let target = self.unit_path(suffix);
            if std::fs::metadata(&target).is_err() {
                exclusive(&target, text.as_bytes())?;
            }
        }
        self.registered_units(path, true)?;
        self.systemd
            .control(&["daemon-reload"], Duration::from_secs(10))?;
        self.registered_units(path, false)?;
        Ok(())
    }

    fn status(&mut self, path: &Path) -> Result<(), Stop> {
        use std::io::Write;
        let owned = self.registered_units(path, false).is_ok();
        let ownership = if owned {
            "registered-current"
        } else {
            "unowned-or-unavailable"
        };
        let line = format!(
            "{{\"unit\": {}, \"ownership\": {}}}",
            json(UNIT),
            json(ownership)
        );
        let _ = writeln!(std::io::stdout(), "{line}");
        let _ = std::io::stdout().flush();
        let properties =
            "--property=ActiveState,SubState,Result,LastTriggerUSec,NextElapseUSecRealtime";
        self.systemd.control(
            &[
                "show",
                &format!("{UNIT}.service"),
                &format!("{UNIT}.timer"),
                properties,
            ],
            Duration::from_secs(3),
        )?;
        Ok(())
    }

    /// One action: its exit code, or why it stopped.
    pub fn act(&mut self, path: &Path, action: Action) -> Result<i32, Stop> {
        self.owner.ancestry(path)?;
        match action {
            Action::Init => self.init(path)?,
            Action::Sample => {
                let (raw, cfg) = self.owner.configuration(path)?;
                return self.sample(path, &raw, &cfg);
            }
            Action::Status => {
                let _lock = self.owner.operation(path)?;
                self.status(path)?;
            }
            Action::Stop | Action::Disable => {
                // Neither loads the configuration or state: registered own
                // units can always be stopped; nothing else by name.
                let _lock = self.owner.operation(path)?;
                self.registered_units(path, false)?;
                self.control(action)?;
            }
            Action::Install => {
                let (_, cfg) = self.owner.configuration(path)?;
                let _lock = self.owner.operation(path)?;
                self.owner.state_directory(&cfg)?;
                self.install(path, &cfg)?;
            }
            Action::Enable | Action::Start => {
                let (_, cfg) = self.owner.configuration(path)?;
                let _lock = self.owner.operation(path)?;
                self.owner.state_directory(&cfg)?;
                // Only a settled record: an interrupted migration is first
                // completed by `install`.
                self.record_units(&Self::registered_path(path), path, false)?;
                self.require_installed_units(path, &cfg)?;
                self.control(action)?;
            }
        }
        Ok(0)
    }

    /// The fixed `systemctl --user` command of a control action.
    fn control(&mut self, action: Action) -> Result<(), Refused> {
        let (timer, service) = (format!("{UNIT}.timer"), format!("{UNIT}.service"));
        let (command, seconds): (Vec<&str>, u64) = match action {
            Action::Stop => (vec!["stop", &timer, &service], 10),
            Action::Disable => (vec!["disable", "--now", &timer], 10),
            Action::Enable => (vec!["enable", "--now", &timer], 10),
            _ => (vec!["start", &service], 95),
        };
        self.systemd.control(&command, Duration::from_secs(seconds))
    }
}

/// The staged migration file of `path`.
fn staged(path: &Path) -> PathBuf {
    let mut staged = path.as_os_str().to_owned();
    staged.push(".migrate");
    PathBuf::from(staged)
}

/// Rename a staged file over its target and sync the directory, so the
/// service is durable before the record follows it.
fn publish(staged: &Path, target: &Path) -> Result<(), Refused> {
    let failed = Refused("Unit migration failed");
    std::fs::rename(staged, target).map_err(|_| failed)?;
    let directory = target.parent().ok_or(failed)?;
    std::fs::File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| failed)
}

/// The collector configuration of USER mode: the dedicated state, no prune
/// source and only the explicitly selected GPU tool.
fn collector_config(state: &Path, cfg: &ObservationConfig) -> Result<Config, Refused> {
    let drives = cfg
        .drives
        .iter()
        .map(|(label, path)| Ok((text_of(label)?, text_of(path)?)))
        .collect::<Result<BTreeMap<_, _>, Refused>>()?;
    let environment = std::env::vars_os()
        .filter(|(key, _)| {
            ["HOME", "LANG", "LC_ALL", "USER", "LOGNAME", "PATH"]
                .iter()
                .any(|kept| key.as_bytes() == kept.as_bytes())
        })
        .collect();
    Ok(Config {
        out_dir: path_text(state)?,
        label: Out::text("user-observations"),
        interval_s: cfg.interval_seconds,
        retention_days: cfg.retention_days,
        rollup_retention_days: cfg.rollup_retention_days,
        drives,
        prune_log_dir: String::new(),
        gpu_auto: cfg.gpu_executable.is_some(),
        nvidia_smi: match &cfg.gpu_executable {
            Some(tool) => text_of(tool)?,
            None => "/disabled/nvidia-smi".into(),
        },
        environment: Some(environment),
        ..Config::default()
    })
}

/// `main(argv)` after argument parsing: the exit status.
pub fn run(context: &mut Context<'_>, path: &Path, action: Action) -> i32 {
    use std::io::Write;
    match context.act(path, action) {
        Ok(code) => code,
        Err(Stop::PreviousRelease) => {
            let _ = writeln!(
                std::io::stderr(),
                "User observation units are from the previous release; run disable, then install"
            );
            2
        }
        Err(Stop::Refused(_)) => {
            let _ = writeln!(
                std::io::stderr(),
                "User observation operation refused or unavailable"
            );
            2
        }
        Err(Stop::Crash(message)) => {
            let _ = writeln!(std::io::stderr(), "{message}");
            1
        }
    }
}
