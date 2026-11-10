//! Exactly two disposable idle Docker leaves. The external parent owns their
//! original create replies; the confined child owns the actual cgroup FDs.
//! This is not a production controller factory or authenticated Q substitute.
use super::*;
use crate::worker_pool::directory::fixture::OwnedLimitFixture;
use reverie_core::operations::JournalDigest;
use std::io::BufRead;

const CASE: &str = "worker_pool::tests::actual_two_hard_leaves_share_confined_pool";

pub(in crate::worker_pool::tests) fn probe_child() {
    assert!(nix::unistd::geteuid().is_root());
    let actual = namespace::assert_controller_namespaces().unwrap();
    let (file, policy) = opened_policy();
    println!(
        "POOL_CONTEXT {} {} {}",
        actual.container, actual.pid, actual.start
    );
    std::io::stdout().flush().unwrap();
    let mut input = std::io::stdin().lock();
    let anchor = command(&mut input);
    assert_eq!(anchor.len(), 3);
    assert_eq!(anchor[0], "ANCHOR");
    let mut owner =
        OwnedLimitFixture::acquire(policy, file, anchor[1].clone(), anchor[2].parse().unwrap());
    owner.configure();
    acknowledge("PARENT_READY");
    for index in 0..2 {
        let leaf = command(&mut input);
        assert_eq!(leaf.len(), 4);
        assert_eq!(leaf[0], "LEAF");
        assert_eq!(leaf[1], index.to_string());
        owner.add_leaf(leaf[2].clone(), leaf[3].parse().unwrap());
        acknowledge(&format!("LEAF_READY_{index}"));
    }
    // Reopen the parent after closing the original descriptors while the
    // external fixture keeps both exact live worker containers running.
    assert_eq!(command(&mut input), ["VERIFY"]);
    let birth =
        JournalDigest::parse(&std::env::var("REVERIE_POOL_CONTEXT_VERSION").unwrap()).unwrap();
    owner.reopen_with_running_leaves(&birth);
    acknowledge("BOTH_READY");
    let mut exit = [0];
    input.read_exact(&mut exit).unwrap();
    assert_eq!(exit, [b'X']);
    owner.close();
}

fn command(input: &mut impl BufRead) -> Vec<String> {
    let mut line = String::new();
    assert!(input.take(256).read_line(&mut line).unwrap() > 0);
    assert!(line.ends_with('\n'));
    line.split_whitespace().map(str::to_owned).collect()
}
fn acknowledge(marker: &str) {
    println!("{marker}");
    std::io::stdout().flush().unwrap();
}

pub(in crate::worker_pool::tests) fn run_parent() {
    let website = Website::capture();
    let mut fixture = Fixture::new_case(CASE, Some(website.id.clone()));
    fixture.create_anchor();
    fixture.create_probe();
    let (controller, pid, start) = fixture.read_probe();
    assert_eq!(Some(&controller), fixture.controller.as_ref());
    let inspected = inspect(&controller);
    assert_eq!(inspected["State"]["Running"], true);
    assert_eq!(inspected["State"]["Pid"], pid);
    assert_eq!(inspected["HostConfig"]["CgroupParent"], "system.slice");
    assert_eq!(process_start(pid), start);
    println!("OWNED_CONTROLLER {controller} PID {pid} START {start}");
    fixture.verify_parent();
    website.assert_outside(&fixture.policy);
    let anchor = inspect(fixture.anchor.as_ref().unwrap());
    let anchor_pid = anchor["State"]["Pid"].as_u64().unwrap();
    let anchor_id = fixture.anchor.clone().unwrap();
    send(&mut fixture, &format!("ANCHOR {anchor_id} {anchor_pid}\n"));
    wait_marker(&mut fixture, "PARENT_READY");
    for index in 0..2 {
        let (id, pid) = create_leaf(&mut fixture, index);
        send(&mut fixture, &format!("LEAF {index} {id} {pid}\n"));
        wait_marker(&mut fixture, &format!("LEAF_READY_{index}"));
        assert_live_leaves(&fixture);
        website.assert_outside(&fixture.policy);
    }
    assert_eq!(fixture.leaves.len(), 2);
    send(&mut fixture, "VERIFY\n");
    wait_marker(&mut fixture, "BOTH_READY");
    assert_live_leaves(&fixture);
    fixture.finish_probe();
    fixture.cleanup_known();
    website.assert_outside(&fixture.policy);
}

fn send(fixture: &mut Fixture, line: &str) {
    fixture
        .input
        .as_mut()
        .unwrap()
        .write_all(line.as_bytes())
        .unwrap();
    fixture.input.as_mut().unwrap().flush().unwrap();
}
fn wait_marker(fixture: &mut Fixture, marker: &str) {
    let end = Instant::now() + Duration::from_secs(20);
    let mut raw = Vec::new();
    loop {
        let eof = docker::drain(fixture.output.as_ref().unwrap(), &mut raw).unwrap();
        let text = std::str::from_utf8(&raw).unwrap();
        if text.lines().any(|line| line == marker) {
            print!("{text}");
            return;
        }
        assert!(
            !eof && Instant::now() < end,
            "owned limit phase retained: {text}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn create_leaf(fixture: &mut Fixture, index: usize) -> (String, u32) {
    let name = format!("{}-leaf-{index}", fixture.policy.deployment);
    assert!(fixture.pending_leaf_name.is_none());
    fixture.pending_leaf_name = Some(name.clone());
    let mems = fs::read_to_string("/sys/fs/cgroup/cpuset.mems.effective").unwrap();
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
        "48g",
        "--memory-swap",
        "48g",
        "--pids-limit",
        "512",
        "--cpu-shares",
        "1024",
        "--cpuset-cpus",
        &fixture.policy.cpu_list(),
        "--cpuset-mems",
        mems.trim(),
        "--cgroup-parent",
        &fixture.policy.parent_slice(),
        "--user",
        &format!(
            "{}:{}",
            fixture.policy.broker_uid, fixture.policy.broker_gid
        ),
        "--entrypoint",
        "/bin/sleep",
        &fixture.policy.anchor_image,
        "infinity",
    ])
    .unwrap();
    let id = raw.trim().to_owned();
    assert!(reverie_contracts::worker_pool::hex_id(&id));
    fixture.leaves.push(id.clone());
    fixture.pending_leaf_name = None;
    docker::run(&["start", &id]).unwrap();
    let inspected = inspect(&id);
    assert_idle_leaf(fixture, &id, &inspected);
    let pid = inspected["State"]["Pid"]
        .as_u64()
        .unwrap()
        .try_into()
        .unwrap();
    println!(
        "OWNED_LEAF {index} {id} PID {pid} START {}",
        process_start(pid)
    );
    (id, pid)
}
fn assert_idle_leaf(fixture: &Fixture, id: &str, value: &serde_json::Value) {
    assert_eq!(value["Id"], id);
    assert_eq!(value["Image"], fixture.policy.anchor_image);
    assert_eq!(value["State"]["Running"], true);
    assert_eq!(
        value["Config"]["Entrypoint"],
        serde_json::json!(["/bin/sleep"])
    );
    assert_eq!(value["Config"]["Cmd"], serde_json::json!(["infinity"]));
    assert_eq!(value["Mounts"], serde_json::json!([]));
    let host = &value["HostConfig"];
    assert_eq!(host["CgroupParent"], fixture.policy.parent_slice());
    assert_eq!(host["Memory"], 51_539_607_552_u64);
    assert_eq!(host["MemorySwap"], 51_539_607_552_u64);
    assert_eq!(host["PidsLimit"], 512);
    assert_eq!(host["CpuQuota"], 0);
    assert_eq!(host["NanoCpus"], 0);
}
fn assert_live_leaves(fixture: &Fixture) {
    for id in &fixture.leaves {
        assert_idle_leaf(fixture, id, &inspect(id));
    }
}
fn inspect(id: &str) -> serde_json::Value {
    assert!(reverie_contracts::worker_pool::hex_id(id));
    let value: serde_json::Value =
        serde_json::from_str(&docker::run(&["inspect", id]).unwrap()).unwrap();
    assert_eq!(value.as_array().unwrap().len(), 1);
    value[0].clone()
}
fn process_start(pid: u32) -> String {
    reverie_contracts::kernel_accounting::process_start(
        &fs::read_to_string(format!("/proc/{pid}/stat")).unwrap(),
    )
    .unwrap()
}
struct Website {
    id: String,
    pid: u32,
    start: String,
}
impl Website {
    fn capture() -> Self {
        let id = std::env::var("REVERIE_POOL_DOCKER_FIXTURE_WEBSITE")
            .expect("explicit actual immutable websiteCID for read-only outside observation");
        let value = inspect(&id);
        assert_eq!(value["Id"], id);
        assert_eq!(value["State"]["Running"], true);
        let pid = value["State"]["Pid"].as_u64().unwrap().try_into().unwrap();
        Self {
            id,
            pid,
            start: process_start(pid),
        }
    }
    fn assert_outside(&self, policy: &WorkerPoolPolicy) {
        let value = inspect(&self.id);
        assert_eq!(value["State"]["Running"], true);
        assert_eq!(value["State"]["Pid"], self.pid);
        assert_eq!(process_start(self.pid), self.start);
        let group = fs::read_to_string(format!("/proc/{}/cgroup", self.pid)).unwrap();
        assert!(!group.contains(&policy.parent_cgroup_relative()));
        assert_eq!(
            group,
            format!("0::/system.slice/docker-{}.scope\n", self.id)
        );
        println!(
            "READONLY_WEBSITE_OUTSIDE {} PID {} START {}",
            self.id, self.pid, self.start
        );
    }
}
