use super::*;
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::PathBuf,
    time::{Duration, Instant},
};
mod lifecycle;

pub(super) fn run(inputs: &inputs::Inputs, signal: &'static str) {
    let mut fixture = Fixture::new(inputs, signal);
    let body = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        fixture.create();
        fixture.start();
        fixture.observe_running();
        fixture.orphan();
        fixture.request_signal();
        fixture.wait_stopped(true).unwrap();
    }));
    let cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fixture.cleanup()));
    match &cleanup {
        Ok(Err(error)) => eprintln!(
            "INIT_FIXTURE_CLEANUP_RETAINED originalCID={:?}: {error}",
            fixture.id
        ),
        Err(_) => eprintln!("INIT_FIXTURE_CLEANUP_PANICKED originalCID={:?}", fixture.id),
        Ok(Ok(())) => (),
    }
    if let Err(error) = body {
        std::panic::resume_unwind(error);
    }
    match cleanup {
        Ok(result) => result.unwrap(),
        Err(error) => std::panic::resume_unwind(error),
    }
}

struct Fixture<'a> {
    inputs: &'a inputs::Inputs,
    root: PathBuf,
    name: String,
    signal: &'static str,
    raw_create: Option<String>,
    id: Option<String>,
    started: Option<String>,
    create_attempted: bool,
    signal_attempted: bool,
    signal_end: Option<Instant>,
    cleanup_attempted: bool,
    cleanup_kill_attempted: bool,
    unknown: bool,
    complete: bool,
}
impl<'a> Fixture<'a> {
    fn new(inputs: &'a inputs::Inputs, signal: &'static str) -> Self {
        assert!(["TERM", "INT"].contains(&signal));
        let mut nonce = [0; 8];
        getrandom::getrandom(&mut nonce).unwrap();
        let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let name = format!("initfixture{suffix}");
        let root = std::env::temp_dir().join(&name);
        let mut owner = Self {
            inputs,
            root,
            name,
            signal,
            raw_create: None,
            id: None,
            started: None,
            create_attempted: false,
            signal_attempted: false,
            signal_end: None,
            cleanup_attempted: false,
            cleanup_kill_attempted: false,
            unknown: false,
            complete: false,
        };
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&owner.root)
            .unwrap();
        fs::copy(
            std::env::current_exe().unwrap(),
            owner.root.join("init-tests.elf"),
        )
        .unwrap();
        fs::set_permissions(
            owner.root.join("init-tests.elf"),
            fs::Permissions::from_mode(0o555),
        )
        .unwrap();
        let raw = serde_json::to_string(&serde_json::json!({
            "name":owner.name,"image":inputs.image,"imageSpec":inputs.image_spec,"init":inputs.init,
            "initSha256":inputs.digest,"signal":signal,"scope":"init-only-no-pool-or-perf-grant"
        }))
        .unwrap();
        owner.receipt("attempt.json", &raw);
        owner
    }
    fn receipt(&mut self, name: &str, raw: &str) {
        self.try_receipt(name, raw).unwrap();
    }
    fn try_receipt(&mut self, name: &str, raw: &str) -> Result<(), String> {
        let result = self.write_receipt(name, raw);
        self.unknown |= result.is_err();
        result
    }
    fn write_receipt(&self, name: &str, raw: &str) -> Result<(), String> {
        let mut file = fs::File::create_new(self.root.join(name)).map_err(|e| e.to_string())?;
        let body = file
            .write_all(raw.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string());
        let closed = crate::native::close(file).map_err(|e| e.to_string());
        checked_pair(body, closed)?;
        let directory = fs::File::open(&self.root).map_err(|e| e.to_string())?;
        let body = directory.sync_all().map_err(|e| e.to_string());
        let closed = crate::native::close(directory).map_err(|e| e.to_string());
        checked_pair(body, closed)
    }
    fn call(&mut self, args: &[&str]) -> Result<String, String> {
        let result = docker::run(args);
        self.unknown |= result.is_err();
        result
    }
    fn create(&mut self) {
        assert!(!self.create_attempted && self.id.is_none());
        let mut args = [
            "create",
            "--pull",
            "never",
            "--init=false",
            "--restart",
            "no",
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--user",
            "1000:100",
            "--memory",
            "512m",
            "--memory-swap",
            "512m",
            "--pids-limit",
            "64",
            "--cpus",
            "1",
            "--cpuset-cpus",
            "0-7",
            "--cgroup-parent",
            "system.slice",
            "--no-healthcheck",
        ]
        .map(str::to_owned)
        .to_vec();
        args.extend([
            "--name".into(),
            self.name.clone(),
            "--hostname".into(),
            self.name.clone(),
            "--tmpfs".into(),
            "/tmp:rw,nosuid,nodev,noexec,size=8m,uid=1000,gid=100,mode=0700".into(),
        ]);
        for (source, target) in [
            (self.inputs.init.clone(), PathBuf::from(INIT)),
            (self.root.join("init-tests.elf"), PathBuf::from(PROBE)),
        ] {
            args.extend([
                "--mount".into(),
                format!(
                    "type=bind,src={},dst={},readonly",
                    source.display(),
                    target.display()
                ),
            ]);
        }
        for path in &self.inputs.closure {
            args.extend([
                "--mount".into(),
                format!(
                    "type=bind,src={},dst={},readonly",
                    path.display(),
                    path.display()
                ),
            ]);
        }
        args.extend([
            "--entrypoint".into(),
            INIT.into(),
            self.inputs.image.clone(),
        ]);
        self.receipt("create-attempted", &self.name.clone());
        self.create_attempted = true;
        let raw = self
            .call(&args.iter().map(String::as_str).collect::<Vec<_>>())
            .unwrap();
        self.raw_create = Some(raw.clone());
        // Try durable raw publication before parsing, but do not unwind on a
        // receipt error until the valid original CID is retained too. Even a
        // malformed reply remains in this SAME owner on any receipt failure.
        let published = self.try_receipt("original-create-stdout", &raw);
        let cid = raw.trim().to_owned();
        if reverie_contracts::worker_pool::hex_id(&cid) {
            self.id = Some(cid.clone());
        }
        published.unwrap();
        assert!(
            self.id.is_some(),
            "original create reply is not one strict CID"
        );
        self.receipt("original-cid", &cid);
        println!(
            "INIT_FIXTURE_CREATED originalCID={cid} name={} signal={}",
            self.name, self.signal
        );
        std::io::stdout().flush().unwrap();
    }
    fn start(&mut self) {
        let id = self.id.clone().unwrap();
        self.receipt("start-attempted", &id);
        self.call(&["start", &id]).unwrap();
    }
    fn orphan(&mut self) {
        let child = match self.exec_phase(transport::Phase::Parent) {
            transport::Outcome::Spawned { child } if child > 1 => child,
            other => self.refuse_probe(transport::Phase::Parent, other),
        };
        match self.exec_phase(transport::Phase::Observer) {
            transport::Outcome::Reaped { child: reaped } if reaped == child => (),
            other => self.refuse_probe(transport::Phase::Observer, other),
        }
        self.observe_running();
    }
    fn refuse_probe(&mut self, phase: transport::Phase, outcome: transport::Outcome) -> ! {
        // A delivered semantic refusal is still an owning-test FAILURE. Only
        // a closed known refusal avoids creating a new transport uncertainty.
        // Existing unknown state is never cleared.
        // After Spawned, only Reaped proves the original child's actual
        // remaining native owners ended. Its private stderr/descriptor errors
        // cannot be inferred known from a later observer refusal.
        self.unknown |= phase == transport::Phase::Observer
            || !matches!(&outcome, transport::Outcome::Refused { .. });
        panic!("original contained probe refused: {outcome:?}");
    }
    fn exec_phase(&mut self, phase: transport::Phase) -> transport::Outcome {
        let selector = match phase {
            transport::Phase::Parent => PARENT,
            transport::Phase::Observer => OBSERVER,
            transport::Phase::Child => panic!("no external child dispatch"),
        };
        let mut bytes = [0; 16];
        getrandom::getrandom(&mut bytes).unwrap();
        let nonce = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let id = self.id.clone().unwrap();
        let raw = self
            .call(&[
                "exec",
                "--env",
                "REVERIE_INIT_PROBE=1",
                "--env",
                &format!("REVERIE_INIT_PHASE={}", phase.name()),
                "--env",
                &format!("REVERIE_INIT_CORRELATION={}", self.name),
                "--env",
                &format!("REVERIE_INIT_NONCE={nonce}"),
                &id,
                PROBE,
                "--ignored",
                "--exact",
                selector,
                "--test-threads=1",
                "--nocapture",
            ])
            .unwrap();
        let decoded = transport::decode(&raw, phase, &self.name, &nonce);
        self.unknown |= decoded.is_err();
        print!("{raw}");
        decoded.unwrap()
    }
    fn request_signal(&mut self) {
        assert!(!self.signal_attempted);
        self.receipt("signal-attempted", self.signal);
        self.signal_end = Some(Instant::now() + Duration::from_secs(5));
        self.signal_attempted = true;
        let id = self.id.clone().unwrap();
        self.call(&["kill", "--signal", self.signal, &id]).unwrap();
    }
}
fn checked_pair(body: Result<(), String>, closed: Result<(), String>) -> Result<(), String> {
    match (body, closed) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(primary), Err(close)) => Err(format!("{primary}; checked close: {close}")),
    }
}
