use super::*;
use crate::native::{self, owned_process as process};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    os::{
        fd::{IntoRawFd, OwnedFd},
        unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    },
    path::PathBuf,
    process::{Child, ChildStdin, Stdio},
    time::{Duration, Instant},
};
const CASE: &str = "worker_pool::tests::actual_implicit_parent_and_confined_controller_namespace";
pub(super) mod limits;

pub(super) fn probe_child() {
    assert!(nix::unistd::geteuid().is_root());
    let actual = namespace::assert_controller_namespaces().unwrap();
    let (file, _) = opened_policy();
    println!(
        "POOL_CONTEXT {} {} {}",
        actual.container, actual.pid, actual.start
    );
    std::io::stdout().flush().unwrap();
    let mut command = [0];
    std::io::stdin().read_exact(&mut command).unwrap();
    assert_eq!(command, [b'X']);
    native::close(file).unwrap();
}

fn opened_policy() -> (File, WorkerPoolPolicy) {
    let digest = std::env::var("REVERIE_POOL_CONTEXT_VERSION").unwrap();
    assert!(reverie_contracts::worker_pool::hex_id(&digest));
    let path = format!("/run/reverie-worker-pool/policies/{digest}.json");
    let file = native::open_at(
        nix::libc::AT_FDCWD,
        std::ffi::OsStr::new(&path),
        nix::libc::O_RDONLY,
    )
    .unwrap();
    let m = file.metadata().unwrap();
    assert_eq!(m.mode() & 0o7777, 0o440);
    assert_eq!(m.gid(), nix::unistd::getegid().as_raw());
    let mut raw = Vec::new();
    (&file).take(65_537).read_to_end(&mut raw).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&raw)), digest);
    let policy = WorkerPoolPolicy::decode(&raw).unwrap();
    assert!(
        nix::sys::statvfs::fstatvfs(&file)
            .unwrap()
            .flags()
            .contains(nix::sys::statvfs::FsFlags::ST_RDONLY)
    );
    (file, policy)
}

pub(super) fn run_parent() {
    let mut fixture = Fixture::new();
    fixture.create_anchor();
    fixture.create_probe();
    let (cid, pid, _) = fixture.read_probe();
    assert_eq!(Some(&cid), fixture.controller.as_ref());
    let inspected: serde_json::Value =
        serde_json::from_str(&docker::run(&["inspect", &cid]).unwrap()).unwrap();
    assert_eq!(inspected[0]["State"]["Running"], true);
    assert_eq!(inspected[0]["State"]["Pid"], pid);
    assert_eq!(inspected[0]["HostConfig"]["CgroupParent"], "system.slice");
    fixture.verify_parent();
    fixture.finish_probe();
    fixture.cleanup_known();
}

struct Fixture {
    root: PathBuf,
    policy: WorkerPoolPolicy,
    version: String,
    anchor: Option<String>,
    controller: Option<String>,
    attach: Option<Child>,
    input: Option<ChildStdin>,
    output: Option<OwnedFd>,
    probe_seen: bool,
    exit_requested: bool,
    complete: bool,
    case: &'static str,
    leaves: Vec<String>,
    pending_leaf_name: Option<String>,
}
impl Fixture {
    fn new() -> Self {
        Self::new_case(CASE, None)
    }
    fn new_case(case: &'static str, website: Option<String>) -> Self {
        let image = std::env::var("REVERIE_POOL_DOCKER_FIXTURE_IMAGE")
            .expect("explicit immutable owned-fixture image");
        assert!(
            image
                .strip_prefix("sha256:")
                .is_some_and(reverie_contracts::worker_pool::hex_id)
        );
        docker::run(&["image", "inspect", &image]).unwrap();
        let info: serde_json::Value =
            serde_json::from_str(&docker::run(&["info", "--format", "{{json .}}"]).unwrap())
                .unwrap();
        assert_eq!(info["CgroupDriver"], "systemd");
        assert_eq!(info["CgroupVersion"], "2");
        let mut random = [0; 8];
        getrandom::getrandom(&mut random).unwrap();
        let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = std::env::temp_dir().join(format!("reverie-pool-fixture-{nonce}"));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let instance = root.join("reverie");
        fs::DirBuilder::new().mode(0o700).create(&instance).unwrap();
        let versions = instance.join("worker-pool/policies");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o750)
            .create(&versions)
            .unwrap();
        let policy = WorkerPoolPolicy {
            version: 1,
            purpose: reverie_contracts::worker_pool::PURPOSE.into(),
            deployment: format!("poolfixture{nonce}"),
            instance_root: instance.to_str().unwrap().into(),
            engine_id: info["ID"].as_str().unwrap().into(),
            anchor_image: image.clone(),
            controller_image: image,
            website_container: website.unwrap_or_else(|| "b".repeat(64)),
            broker_uid: nix::unistd::geteuid().as_raw(),
            broker_gid: nix::unistd::getegid().as_raw(),
            memory_max_mi_b: 49_152,
            pool_tasks_max: 8192,
            cpu_weight: 100,
            allowed_cpus: (0..8).collect(),
            employee_memory_high_mi_b: std::collections::BTreeMap::from([(
                "22222222-2222-4222-8222-222222222222".into(),
                1536,
            )]),
        };
        policy.validate().unwrap();
        let raw = serde_json::to_vec(&policy).unwrap();
        let version = format!("{:x}", Sha256::digest(&raw));
        fs::write(versions.join(format!("{version}.json")), raw).unwrap();
        fs::set_permissions(
            versions.join(format!("{version}.json")),
            fs::Permissions::from_mode(0o440),
        )
        .unwrap();
        fs::copy(
            std::env::current_exe().unwrap(),
            root.join("host-tests.elf"),
        )
        .unwrap();
        fs::set_permissions(
            root.join("host-tests.elf"),
            fs::Permissions::from_mode(0o550),
        )
        .unwrap();
        Self {
            root,
            policy,
            version,
            anchor: None,
            controller: None,
            attach: None,
            input: None,
            output: None,
            probe_seen: false,
            exit_requested: false,
            complete: false,
            case,
            leaves: Vec::new(),
            pending_leaf_name: None,
        }
    }
    fn create_anchor(&mut self) {
        let top = self.policy.parent_components()[0].clone();
        assert!(
            !PathBuf::from("/sys/fs/cgroup").join(top).exists(),
            "fresh uniquely owned hierarchy"
        );
        let name = self.policy.anchor_name();
        let raw = docker::run(&[
            "create",
            "--pull",
            "never",
            "--name",
            &name,
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--read-only",
            "--memory",
            "64m",
            "--memory-swap",
            "64m",
            "--pids-limit",
            "16",
            "--cpu-shares",
            "2",
            "--cpuset-cpus",
            &self.policy.cpu_list(),
            "--cgroup-parent",
            &self.policy.parent_slice(),
            "--user",
            &format!("{}:{}", self.policy.broker_uid, self.policy.broker_gid),
            "--entrypoint",
            "/bin/sleep",
            &self.policy.anchor_image,
            "infinity",
        ])
        .unwrap();
        let id = raw.trim().to_owned();
        assert!(reverie_contracts::worker_pool::hex_id(&id));
        self.anchor = Some(id.clone());
        docker::run(&["start", &id]).unwrap();
    }
    fn create_probe(&mut self) {
        let versions = format!(
            "type=bind,src={}/worker-pool/policies,dst=/run/reverie-worker-pool/policies,readonly",
            self.policy.instance_root
        );
        let executable = format!(
            "type=bind,src={},dst=/pool-tests.elf,readonly",
            self.root.join("host-tests.elf").display()
        );
        let raw = docker::run(&[
            "create",
            "--pull",
            "never",
            "--interactive",
            "--name",
            &self.policy.controller_name(),
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--read-only",
            "--memory",
            "256m",
            "--memory-swap",
            "256m",
            "--pids-limit",
            "128",
            "--cpuset-cpus",
            &self.policy.cpu_list(),
            "--pid",
            "host",
            "--cgroupns",
            "host",
            "--userns",
            "host",
            "--cgroup-parent",
            "system.slice",
            "--user",
            &format!("0:{}", self.policy.broker_gid),
            "--mount",
            "type=bind,src=/proc,dst=/run/reverie-host-proc,readonly",
            "--mount",
            "type=bind,src=/sys/fs/cgroup,dst=/sys/fs/cgroup",
            "--mount",
            &versions,
            "--mount",
            &executable,
            "--env",
            "REVERIE_POOL_CONTEXT_CHILD=1",
            "--env",
            "REVERIE_POOL_LIMITS_CHILD=1",
            "--env",
            &format!("REVERIE_POOL_CONTEXT_VERSION={}", self.version),
            "--env",
            "RUST_BACKTRACE=0",
            "--entrypoint",
            "/pool-tests.elf",
            &self.policy.controller_image,
            "--ignored",
            "--exact",
            self.case,
            "--test-threads=1",
            "--nocapture",
        ])
        .unwrap();
        let id = raw.trim().to_owned();
        assert!(reverie_contracts::worker_pool::hex_id(&id));
        self.controller = Some(id.clone());
        let child = docker::command()
            .args(["start", "--attach", "--interactive", &id])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        self.attach = Some(child);
        let child = self.attach.as_mut().unwrap();
        self.input = child.stdin.take();
        let output: OwnedFd = child.stdout.take().unwrap().into();
        self.output = Some(output);
        process::nonblocking(self.output.as_ref().unwrap()).unwrap();
    }
    fn read_probe(&mut self) -> (String, u32, String) {
        let end = Instant::now() + Duration::from_secs(20);
        let mut raw = Vec::new();
        loop {
            let eof = docker::drain(self.output.as_ref().unwrap(), &mut raw).unwrap();
            let text = String::from_utf8_lossy(&raw);
            if let Some((_, rest)) = text.split_once("POOL_CONTEXT ")
                && let Some((line, _)) = rest.split_once('\n')
            {
                let fields: Vec<_> = line.split_whitespace().collect();
                assert_eq!(fields.len(), 3);
                self.probe_seen = true;
                return (
                    fields[0].into(),
                    fields[1].parse().unwrap(),
                    fields[2].into(),
                );
            }
            assert!(
                !eof && Instant::now() < end,
                "actual probe unavailable; retained {}: {text}",
                self.root.display()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn verify_parent(&self) {
        let path = PathBuf::from("/sys/fs/cgroup").join(self.policy.parent_cgroup_relative());
        let parent = fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW)
            .open(&path)
            .unwrap();
        let held = parent.metadata().unwrap();
        assert_eq!(held.uid(), 0);
        assert_eq!((held.dev(), held.ino()), {
            let m = fs::metadata(&path).unwrap();
            (m.dev(), m.ino())
        });
        let inspected: serde_json::Value = serde_json::from_str(
            &docker::run(&["inspect", self.anchor.as_ref().unwrap()]).unwrap(),
        )
        .unwrap();
        let pid = inspected[0]["State"]["Pid"].as_u64().unwrap();
        assert!(pid > 1);
        assert_eq!(
            fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap(),
            format!(
                "0::/{}/docker-{}.scope\n",
                self.policy.parent_cgroup_relative(),
                self.anchor.as_ref().unwrap()
            )
        );
        println!(
            "OWNED_PARENT {} {}:{} ANCHOR {} PID {}",
            self.policy.parent_slice(),
            held.dev(),
            held.ino(),
            self.anchor.as_ref().unwrap(),
            pid
        );
        nix::unistd::close(parent.into_raw_fd()).unwrap();
    }
    fn finish_probe(&mut self) {
        assert!(self.probe_seen && !self.exit_requested);
        self.exit_requested = true;
        self.input.as_mut().unwrap().write_all(b"X").unwrap();
        let input: OwnedFd = self.input.take().unwrap().into();
        process::close(input).unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        while self.attach.as_mut().unwrap().try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < end,
                "owned probe exit retained at {}",
                self.root.display()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(self.attach.as_mut().unwrap().wait().unwrap().success());
        self.attach = None;
        process::close(self.output.take().unwrap()).unwrap();
    }
    fn cleanup_known(&mut self) {
        assert!(self.pending_leaf_name.is_none());
        for leaf in &self.leaves {
            docker::run(&["stop", "--time", "2", leaf]).unwrap();
            docker::run(&["rm", leaf]).unwrap();
        }
        self.leaves.clear();
        let controller = self.controller.as_ref().unwrap();
        docker::run(&["rm", controller]).unwrap();
        self.controller = None;
        let anchor = self.anchor.as_ref().unwrap();
        docker::run(&["stop", "--time", "2", anchor]).unwrap();
        docker::run(&["rm", anchor]).unwrap();
        self.anchor = None;
        self.complete = true;
        fs::remove_dir_all(&self.root).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.complete {
            self.settle_probe_unwind();
            eprintln!(
                "OWNED_FIXTURE_RETAINED root={} anchor={:?} controller={:?} leaves={:?} pending_leaf={:?}; no cleanup acknowledgement",
                self.root.display(),
                self.anchor,
                self.controller,
                self.leaves,
                self.pending_leaf_name
            );
            std::mem::forget((self.attach.take(), self.input.take(), self.output.take()));
        }
    }
}
impl Fixture {
    fn settle_probe_unwind(&mut self) {
        if !self.exit_requested {
            self.exit_requested = true;
            if let Some(mut input) = self.input.take() {
                let _ = input.write_all(b"X");
                let fd: OwnedFd = input.into();
                let _ = process::close(fd);
            }
        }
        if self.attach.as_mut().is_some_and(settle_attached) {
            self.attach = None;
        }
        if self.attach.is_none()
            && let Some(output) = self.output.take()
        {
            let _ = process::close(output);
        }
    }
}
fn settle_attached(child: &mut Child) -> bool {
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(5)),
            // Only this unreaped actual Child can be signalled. Any daemon
            // start outcome remains retained; do not rm/stop a container here.
            _ => return child.kill().is_ok() && child.wait().is_ok(),
        }
    }
}
use std::os::unix::fs::OpenOptionsExt;
