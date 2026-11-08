use super::*;
use crate::native::owned_process as process;
use serde_json::Value;
use std::{
    fs,
    io::Write,
    os::{
        fd::OwnedFd,
        unix::fs::{DirBuilderExt, PermissionsExt},
    },
    path::PathBuf,
    process::{Child, ChildStdin, Stdio},
    time::{Duration, Instant},
};

pub(super) fn run() {
    let inputs = inputs::Inputs::capture();
    inputs.verify_image();
    let mut fixture = Fixture::new(inputs);
    let body = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        fixture.create();
        fixture.start();
        fixture.wait_ready();
        fixture.inspect_running();
        fixture.input.as_mut().unwrap().write_all(b"R").unwrap();
        fixture.close_input().unwrap();
        fixture.wait_exit();
        fixture.assert_guest_exit_success();
    }));
    let cleaned = fixture.cleanup_known();
    if let Err(error) = &cleaned {
        eprintln!("ROOTLESS_PERF_CLEANUP_RETAINED {error}");
    }
    if let Err(primary) = body {
        std::panic::resume_unwind(primary);
    }
    cleaned.unwrap();
}
struct Fixture {
    inputs: inputs::Inputs,
    root: PathBuf,
    name: String,
    id: Option<String>,
    attach: Option<Child>,
    input: Option<ChildStdin>,
    output: Option<OwnedFd>,
    raw: Vec<u8>,
    complete: bool,
    create_attempted: bool,
    cleanup_attempted: bool,
    close_unknown: bool,
}
impl Fixture {
    fn new(inputs: inputs::Inputs) -> Self {
        let mut random = [0u8; 8];
        getrandom::getrandom(&mut random).unwrap();
        let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let name = format!("reverie-rootless-perf-{nonce}");
        let root = std::env::temp_dir().join(&name);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let owner = Self {
            inputs,
            root,
            name,
            id: None,
            attach: None,
            input: None,
            output: None,
            raw: Vec::new(),
            complete: false,
            create_attempted: false,
            cleanup_attempted: false,
            close_unknown: false,
        };
        fs::copy(
            std::env::current_exe().unwrap(),
            owner.root.join("perf-tests.elf"),
        )
        .unwrap();
        fs::set_permissions(
            owner.root.join("perf-tests.elf"),
            fs::Permissions::from_mode(0o555),
        )
        .unwrap();
        rootfs::create(&owner.root.join("rootfs.tar"));
        fs::write(
            owner.root.join("core-closure.json"),
            serde_json::to_vec(&owner.inputs.core_closure).unwrap(),
        )
        .unwrap();
        for name in ["rootfs.tar", "core-closure.json"] {
            // Nonsecret fixture inputs must remain readable when CI's host
            // UID/umask differs from the image's fixed employee UID1000.
            fs::set_permissions(owner.root.join(name), fs::Permissions::from_mode(0o444)).unwrap();
        }
        owner
    }
    fn create(&mut self) {
        assert!(self.id.is_none());
        let mut args = vec![
            "create".into(),
            "--pull".into(),
            "never".into(),
            "--interactive".into(),
            "--name".into(),
            self.name.clone(),
            "--network".into(),
            "none".into(),
            "--read-only".into(),
            "--user".into(),
            "1000:100".into(),
            "--memory".into(),
            "1536m".into(),
            "--memory-swap".into(),
            "1536m".into(),
            "--pids-limit".into(),
            "512".into(),
            "--cpuset-cpus".into(),
            "0-7".into(),
            "--cgroup-parent".into(),
            "system.slice".into(),
        ];
        args.extend(self.inputs.security.clone());
        args.extend(self.inputs.runtime.clone());
        for value in [
            "/tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=100,mode=0700",
            "/home/agent:rw,nosuid,nodev,size=256m,uid=1000,gid=100,mode=0700",
        ] {
            args.extend(["--tmpfs".into(), value.into()]);
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
            "--mount".into(),
            format!(
                "type=bind,src={},dst=/run/reverie-perf-tests.elf,readonly",
                self.root.join("perf-tests.elf").display()
            ),
        ]);
        for name in ["rootfs.tar", "core-closure.json"] {
            args.extend([
                "--mount".into(),
                format!(
                    "type=bind,src={},dst=/run/reverie-perf-input/{name},readonly",
                    self.root.join(name).display()
                ),
            ]);
        }
        for value in [
            "REVERIE_TASK_PERF_GUEST=1".into(),
            format!("REVERIE_PERF_GUEST_TOOLS={}", self.inputs.tools.display()),
            format!(
                "REVERIE_PERF_GUEST_COREUTILS={}",
                self.inputs.coreutils.display()
            ),
        ] {
            args.extend(["--env".into(), value]);
        }
        args.extend([
            "--entrypoint".into(),
            "/run/reverie-perf-tests.elf".into(),
            self.inputs.image.clone(),
            "--ignored".into(),
            "--exact".into(),
            CASE.into(),
            "--test-threads=1".into(),
            "--nocapture".into(),
        ]);
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        self.create_attempted = true;
        let raw = docker::run(&borrowed).unwrap();
        let id = raw.trim().to_owned();
        assert!(reverie_contracts::worker_pool::hex_id(&id));
        self.id = Some(id);
    }
    fn start(&mut self) {
        let child = docker::command()
            .args([
                "start",
                "--attach",
                "--interactive",
                self.id.as_ref().unwrap(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        self.attach = Some(child);
        let child = self.attach.as_mut().unwrap();
        self.input = child.stdin.take();
        self.output = Some(child.stdout.take().unwrap().into());
        process::nonblocking(self.output.as_ref().unwrap()).unwrap();
    }
    fn wait_ready(&mut self) {
        let end = Instant::now() + Duration::from_secs(30);
        loop {
            let eof = docker::drain(self.output.as_ref().unwrap(), &mut self.raw).unwrap();
            if String::from_utf8_lossy(&self.raw).contains("PERF_GUEST_READY ") {
                return;
            }
            assert!(
                !eof && Instant::now() < end,
                "actual guest startup retained: {}",
                String::from_utf8_lossy(&self.raw)
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn inspect_running(&self) {
        let id = self.id.as_ref().unwrap();
        let raw = docker::run(&["inspect", id]).unwrap();
        let rows: Value = serde_json::from_str(&raw).unwrap();
        let row = &rows[0];
        assert_eq!(row["Id"], id.as_str());
        assert_eq!(row["Image"], self.inputs.image);
        assert_eq!(row["State"]["Running"], true);
        assert_eq!(row["Config"]["User"], "1000:100");
        let host = &row["HostConfig"];
        assert_eq!(host["Privileged"], false);
        assert_eq!(host["ReadonlyRootfs"], true);
        assert_eq!(host["NetworkMode"], "none");
        assert_eq!(host["CapDrop"], serde_json::json!(["ALL"]));
        let mut caps = host["CapAdd"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>();
        caps.sort_unstable();
        assert_eq!(caps, ["SETGID", "SETUID"]);
        let options = host["SecurityOpt"].as_array().unwrap();
        assert!(options.iter().any(|v| v == "systempaths=unconfined"));
        assert!(!options.iter().any(|v| {
            v.as_str()
                .is_some_and(|s| s.starts_with("no-new-privileges"))
        }));
        let pid = row["State"]["Pid"].as_u64().unwrap();
        assert!(pid > 1);
        let group = fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
        assert_eq!(group, format!("0::/system.slice/docker-{id}.scope\n"));
        let directory =
            PathBuf::from("/sys/fs/cgroup").join(group.trim().strip_prefix("0::/").unwrap());
        for (name, expected) in [
            ("memory.max", "1610612736"),
            ("memory.swap.max", "0"),
            ("pids.max", "512"),
            ("cpu.max", "max 100000"),
            ("cpuset.cpus.effective", "0-7"),
        ] {
            let actual = fs::read_to_string(directory.join(name)).unwrap();
            assert_eq!(actual.trim(), expected, "{name}");
            println!("OUTER_KERNEL_LIMIT {name}={}", actual.trim());
        }
        println!(
            "OWNED_ROOTLESS_PERF_CONTAINER originalCID={id} pid={pid} image={}",
            self.inputs.image
        );
    }
    fn wait_exit(&mut self) {
        let end = Instant::now() + Duration::from_secs(180);
        loop {
            let eof = docker::drain(self.output.as_ref().unwrap(), &mut self.raw).unwrap();
            if let Some(status) = self
                .attach
                .as_mut()
                .unwrap()
                .try_wait()
                .unwrap()
                .filter(|_| eof)
            {
                print!("{}", String::from_utf8_lossy(&self.raw));
                assert!(
                    status.success(),
                    "actual perf/rootless refusal is NOT a passed/unsupported skip"
                );
                let text = String::from_utf8_lossy(&self.raw);
                let manifest: Value = serde_json::from_str(
                    text.lines()
                        .find_map(|line| line.strip_prefix("PERF_ACCEPTANCE "))
                        .unwrap(),
                )
                .unwrap();
                assert_eq!(manifest["status"], "passed");
                assert_eq!(manifest["innerRootlessNativeWorkload"], true);
                assert_eq!(manifest["innerWorkloadPerfProfiled"], false);
                self.attach = None;
                self.close_output().unwrap();
                return;
            }
            assert!(
                Instant::now() < end,
                "owned perf fixture outcome retained: {}",
                String::from_utf8_lossy(&self.raw)
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn close_input(&mut self) -> Result<(), String> {
        let result = self
            .input
            .take()
            .map(|file| process::close(OwnedFd::from(file)))
            .transpose()
            .map(|_| ())
            .map_err(|error| error.to_string());
        self.close_unknown |= result.is_err();
        result
    }
    fn assert_guest_exit_success(&self) {
        let id = self.id.as_ref().unwrap();
        let rows: Value = serde_json::from_str(&docker::run(&["inspect", id]).unwrap()).unwrap();
        assert_eq!(rows[0]["Id"], id.as_str());
        assert_eq!(rows[0]["Image"], self.inputs.image);
        assert_eq!(rows[0]["State"]["Running"], false);
        assert_eq!(rows[0]["State"]["Pid"], 0);
        assert_eq!(rows[0]["State"]["ExitCode"], 0);
    }
    fn close_output(&mut self) -> Result<(), String> {
        let result = self
            .output
            .take()
            .map(process::close)
            .transpose()
            .map(|_| ())
            .map_err(|error| error.to_string());
        self.close_unknown |= result.is_err();
        result
    }
    fn cleanup_known(&mut self) -> Result<(), String> {
        if self.cleanup_attempted {
            return Err("same fixture cleanup already attempted".into());
        }
        self.cleanup_attempted = true;
        let input = self.close_input();
        self.stop_original_if_running()?;
        if self.attach.as_mut().is_some_and(settle_attach) {
            self.attach = None;
        }
        if self.attach.is_some() {
            return Err("actual attach CLI remains retained".into());
        }
        let output = self.close_output();
        input?;
        output?;
        if self.close_unknown {
            return Err("consumed metadata close remains opaque".into());
        }
        if let Some(id) = self.id.as_ref() {
            let rows: Value =
                serde_json::from_str(&docker::run(&["inspect", id])?).map_err(|e| e.to_string())?;
            if rows[0]["Id"] != id.as_str()
                || rows[0]["State"]["Running"] != false
                || rows[0]["State"]["Pid"] != 0
            {
                return Err("original fixture native stop unknown".into());
            }
            docker::run(&["rm", id])?;
            println!("OWNED_ROOTLESS_PERF_REMOVED originalCID={id}");
            self.id = None;
        }
        fs::remove_dir_all(&self.root).map_err(|e| e.to_string())?;
        self.complete = true;
        Ok(())
    }
    fn stop_original_if_running(&self) -> Result<(), String> {
        let Some(id) = self.id.as_ref() else {
            return if self.create_attempted {
                Err("create reply unknown; retain exact unique name".into())
            } else {
                Ok(())
            };
        };
        let rows: Value =
            serde_json::from_str(&docker::run(&["inspect", id])?).map_err(|e| e.to_string())?;
        if rows[0]["Id"] != id.as_str() {
            return Err("original fixture identity changed".into());
        }
        match rows[0]["State"]["Running"].as_bool() {
            Some(true) => {
                docker::run(&["stop", "--time", "2", id])?;
                Ok(())
            }
            Some(false) => Ok(()),
            None => Err("native running state unknown".into()),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.complete {
            if let Some(input) = self.input.take() {
                let file: OwnedFd = input.into();
                let _ = process::close(file);
            }
            if self.attach.as_mut().is_some_and(settle_attach) {
                self.attach = None;
            }
            if self.attach.is_none()
                && let Some(output) = self.output.take()
            {
                let _ = process::close(output);
            }
            eprintln!(
                "ROOTLESS_PERF_FIXTURE_RETAINED name={} originalCID={:?} root={}; no cleanup acknowledgement",
                self.name,
                self.id,
                self.root.display()
            );
            std::mem::forget((self.attach.take(), self.output.take()));
        }
    }
}
fn settle_attach(child: &mut Child) -> bool {
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => return false,
        }
    }
    // Only the actual unreaped owned CLI is signalled. Its container remains
    // retained regardless; killing this client is no daemon-effect receipt.
    if child.kill().is_err() {
        return false;
    }
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => return false,
        }
    }
    false
}
