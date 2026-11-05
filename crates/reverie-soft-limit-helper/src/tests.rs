use super::*;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink};
use std::sync::atomic::{AtomicU64, Ordering};

const SID: &str = "11111111-1111-4111-8111-111111111111";
const EID: &str = "22222222-2222-4222-8222-222222222222";
const CID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static NEXT: AtomicU64 = AtomicU64::new(0);
// These are the only tests that fork. Hold the gate across writing and executing
// an engine fixture, so a peer fork cannot inherit its transient writable fd.
static ENGINE_FIXTURES: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct Tree {
    root: PathBuf,
    proc: PathBuf,
    cgroup: PathBuf,
    home: PathBuf,
    leaf: PathBuf,
}
impl Tree {
    fn new() -> Self {
        os::faults::reset();
        let root = std::env::temp_dir().join(format!(
            "reverie-rust-helper-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let proc = root.join("proc");
        let cgroup = root.join("cg");
        let home = root.join("state/employees").join(EID).join("home");
        let leaf = cgroup.join("system.slice/laptop");
        for path in [
            proc.join("4242"),
            proc.join("sys/kernel"),
            proc.join("self"),
            home.clone(),
            leaf.clone(),
            root.join("etc"),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(
            proc.join("4242/stat"),
            format!(
                "4242 (sleep) S {}",
                (1..30).map(|n| n.to_string()).collect::<Vec<_>>().join(" ")
            ),
        )
        .unwrap();
        fs::write(proc.join("4242/cgroup"), "0::/system.slice/laptop\n").unwrap();
        fs::write(proc.join("sys/kernel/osrelease"), "6.18.39\n").unwrap();
        fs::write(
            proc.join("self/mountinfo"),
            format!("30 1 0:26 / {} rw - cgroup2 cgroup2 rw\n", cgroup.display()),
        )
        .unwrap();
        fs::write(leaf.join("memory.max"), format!("{}\n", 4096 * MIB)).unwrap();
        fs::write(leaf.join("memory.high"), "max\n").unwrap();
        Self {
            root,
            proc,
            cgroup,
            home,
            leaf,
        }
    }
    fn policy_value(&self) -> serde_json::Value {
        serde_json::json!({"v":1,"deployment":"reverie","stateRoot":self.root.join("state"),
            "qualifiedKernel":{"osrelease":"6.18.39"},"entries":[{"employeeId":EID,"home":self.home,"memoryMaxMiB":4096,"memoryHighMiB":1024}]})
    }
    fn policy(&self) -> Policy {
        validate_policy(serde_json::from_value(self.policy_value()).unwrap()).unwrap()
    }
    fn row(&self) -> EngineRow {
        serde_json::from_value(serde_json::json!({"Id":CID,"Name":format!("/reverie-agent-{SID}"),
        "Config":{"Labels":{"reverie.worker":"reverie","reverie.session":SID}},"State":{"Running":true,"Pid":4242},
        "Mounts":[{"Type":"bind","Source":self.home,"Destination":"/home/agent"}],"HostConfig":{"Memory":4096*MIB}})).unwrap()
    }
    fn high(&self) -> String {
        fs::read_to_string(self.leaf.join("memory.high"))
            .unwrap()
            .trim()
            .to_owned()
    }
    fn apply<F: FnMut() -> Result<bool>>(&self, recheck: F, deadline: Instant) -> Result<u64> {
        apply_high(
            &self.policy().entries[0],
            4242,
            &self.cgroup,
            &self.proc,
            recheck,
            deadline,
        )
    }
    fn pins(&self) -> Pins {
        Pins {
            broker_uid: u32::MAX,
            deployment: "reverie".into(),
            engine: PathBuf::from("/missing-engine"),
            endpoint: "unix:///run/docker.sock".into(),
            policy: self.root.join("etc/policy.json"),
            state_root: self.root.join("state").display().to_string(),
        }
    }
    fn assert_no_fds(&self) {
        let count = fs::read_dir("/proc/self/fd")
            .unwrap()
            .flatten()
            .filter(|entry| {
                fs::read_link(entry.path()).is_ok_and(|path| path.starts_with(&self.root))
            })
            .count();
        assert_eq!(count, 0, "fixture-owned descriptors leaked");
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        os::faults::reset();
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn request() -> Vec<u8> {
    format!("{{\"v\":1,\"sessionId\":\"{SID}\",\"containerId\":\"{CID}\"}}\n").into_bytes()
}
fn future() -> Instant {
    Instant::now() + Duration::from_secs(8)
}

#[test]
fn request_rejects_unknown_duplicate_escaped_duplicate_and_non_integer_versions() {
    assert!(parse_request(&request()).is_ok());
    let valid = String::from_utf8(request()).unwrap();
    for bad in [
        valid.replace("\"v\":1", "\"v\":true"),
        valid.replace("\"v\":1", "\"v\":1.0"),
        valid.replace("\"v\":1", "\"v\":1,\"v\":1"),
        valid.replace("\"v\":1", "\"v\":1,\"\\u0076\":1"),
        valid.replace("\"v\":1", "\"v\":1,\"extra\":0"),
        valid.replace(CID, &CID.to_uppercase()),
        valid.trim_end().into(),
        valid.clone() + &valid,
        " ".repeat(513) + "\n",
    ] {
        assert_eq!(
            parse_request(bad.as_bytes()).unwrap_err(),
            Failure::Refused("REQUEST_INVALID")
        );
    }
}
#[test]
fn policy_rejects_duplicate_keys_unknown_fields_invalid_paths_and_limits() {
    let tree = Tree::new();
    let valid = serde_json::to_string(&tree.policy_value()).unwrap();
    for bad in [
        valid.replace("\"v\":1", "\"v\":1,\"v\":1"),
        valid.replace("\"v\":1", "\"v\":true"),
        valid.replace("\"memoryHighMiB\":1024", "\"memoryHighMiB\":4096"),
        valid.replace("\"memoryHighMiB\":1024", "\"memoryHighMiB\":511"),
        valid.replace("\"memoryHighMiB\":1024", "\"memoryHighMiB\":1024.0"),
        valid.replace("\"v\":1", "\"v\":1,\"extra\":0"),
        valid.replace("/state\"", "/state/../state\""),
        valid.replace("/state\"", "/state//\""),
        valid.replace("/state\"", "/state/.\""),
    ] {
        let result = serde_json::from_str::<Policy>(&bad)
            .map_err(|_| Failure::Refused("POLICY_INVALID"))
            .and_then(validate_policy);
        assert_eq!(
            result.unwrap_err(),
            Failure::Refused("POLICY_INVALID"),
            "{bad}"
        );
    }
    let mut value = tree.policy_value();
    let entry = value["entries"][0].clone();
    value["entries"].as_array_mut().unwrap().push(entry);
    assert!(validate_policy(serde_json::from_value(value).unwrap()).is_err());
}
#[test]
fn policy_custody_refuses_symlinks_writable_parents_files_and_non_regular_files() {
    let tree = Tree::new();
    let path = tree.root.join("etc/policy.json");
    fs::write(&path, serde_json::to_vec(&tree.policy_value()).unwrap()).unwrap();
    let uid = fs::metadata(&tree.root).unwrap().uid();
    assert!(load_policy(&path, &tree.root, uid).is_ok());
    for candidate in [&path, &tree.root.join("etc")] {
        fs::set_permissions(candidate, fs::Permissions::from_mode(0o775)).unwrap();
        assert_eq!(
            load_policy(&path, &tree.root, uid).unwrap_err(),
            Failure::Refused("POLICY_UNTRUSTED")
        );
        fs::set_permissions(candidate, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let link = tree.root.join("etc/link");
    symlink(&path, &link).unwrap();
    assert_eq!(
        load_policy(&link, &tree.root, uid).unwrap_err(),
        Failure::Refused("POLICY_UNTRUSTED")
    );
    assert_eq!(
        load_policy(&tree.root.join("etc"), &tree.root, uid).unwrap_err(),
        Failure::Refused("POLICY_UNTRUSTED")
    );
    tree.assert_no_fds();
}
#[test]
fn qualified_kernel_and_full_host_cgroup_root_are_required() {
    let tree = Tree::new();
    assert!(check_kernel(&tree.policy(), &tree.proc).is_ok());
    assert!(check_host_root(&tree.proc, &tree.cgroup).is_ok());
    fs::write(tree.proc.join("sys/kernel/osrelease"), "6.12.0\n").unwrap();
    assert_eq!(
        check_kernel(&tree.policy(), &tree.proc),
        Err(Failure::Refused("KERNEL_UNQUALIFIED"))
    );
    for line in [
        format!(
            "30 1 0:26 /sub {} rw - cgroup2 cgroup2 rw",
            tree.cgroup.display()
        ),
        format!("30 1 0:26 / {} rw - tmpfs t rw", tree.cgroup.display()),
        String::new(),
    ] {
        fs::write(tree.proc.join("self/mountinfo"), line).unwrap();
        assert_eq!(
            check_host_root(&tree.proc, &tree.cgroup),
            Err(Failure::Refused("HOST_HIERARCHY_REQUIRED"))
        );
    }
}
#[test]
fn engine_identity_exact_home_and_hard_limit_bind_the_policy() {
    let tree = Tree::new();
    let policy = tree.policy();
    let req = parse_request(&request()).unwrap();
    let mut row = tree.row();
    assert_eq!(select_entry(&policy, &row, &req).unwrap().high, 1024);
    row.id = "b".repeat(64);
    assert_eq!(
        select_entry(&policy, &row, &req).unwrap_err(),
        Failure::Refused("IDENTITY_MISMATCH")
    );
    row = tree.row();
    row.mounts.push(row.mounts[0].clone());
    assert_eq!(
        select_entry(&policy, &row, &req).unwrap_err(),
        Failure::Refused("POLICY_NO_MATCH")
    );
    row = tree.row();
    row.host_config.memory = 8192 * MIB;
    assert_eq!(
        select_entry(&policy, &row, &req).unwrap_err(),
        Failure::Refused("HARD_LIMIT_MISMATCH")
    );
    row = tree.row();
    fs::remove_dir(&tree.home).unwrap();
    symlink(&tree.root, &tree.home).unwrap();
    assert_eq!(
        select_entry(&policy, &row, &req).unwrap_err(),
        Failure::Refused("POLICY_NO_MATCH")
    );
}
#[test]
fn write_uses_policy_value_and_releases_every_owned_fd() {
    let tree = Tree::new();
    assert_eq!(tree.apply(|| Ok(true), future()), Ok(1024 * MIB));
    assert_eq!(tree.high(), (1024 * MIB).to_string());
    tree.assert_no_fds();
}
#[test]
fn slow_recheck_drift_is_refused_before_writer_open() {
    for drift in ["max", "pid", "cgroup"] {
        let tree = Tree::new();
        let result = tree.apply(
            || {
                match drift {
                    "max" => fs::write(tree.leaf.join("memory.max"), "max\n"),
                    "pid" => fs::write(tree.proc.join("4242/stat"), "4242 (sleep) S changed"),
                    _ => fs::write(tree.proc.join("4242/cgroup"), "0::/other\n"),
                }
                .unwrap();
                Ok(true)
            },
            future(),
        );
        assert!(matches!(result, Err(Failure::Refused(_))));
        assert_eq!(tree.high(), "max");
        tree.assert_no_fds();
    }
}
#[test]
fn prewrite_recheck_crossing_fixed_deadline_makes_zero_writes() {
    let tree = Tree::new();
    let deadline = Instant::now() + Duration::from_millis(1);
    assert_eq!(
        tree.apply(
            || {
                std::thread::sleep(Duration::from_millis(3));
                Ok(true)
            },
            deadline
        ),
        Err(Failure::Refused("DEADLINE"))
    );
    assert_eq!(tree.high(), "max");
    tree.assert_no_fds();
}
#[test]
fn postwrite_recheck_and_pid_cgroup_hard_limit_drift_are_always_uncertain() {
    for drift in ["refuse", "pid", "cgroup", "max"] {
        let tree = Tree::new();
        let mut count = 0;
        let result = tree.apply(
            || {
                count += 1;
                if count == 2 {
                    match drift {
                        "refuse" => return Err(Failure::Refused("DEADLINE")),
                        "pid" => fs::write(tree.proc.join("4242/stat"), "4242 (sleep) S changed"),
                        "cgroup" => fs::write(tree.proc.join("4242/cgroup"), "0::/other\n"),
                        _ => fs::write(tree.leaf.join("memory.max"), "max\n"),
                    }
                    .unwrap();
                }
                Ok(true)
            },
            future(),
        );
        assert_eq!(result, Err(Failure::Unconfirmed));
        assert_eq!(tree.high(), (1024 * MIB).to_string());
        tree.assert_no_fds();
    }
}
#[test]
fn writer_close_leaf_close_and_interrupted_write_failures_are_uncertain() {
    for name in ["memory.high", "laptop", "write", "partial"] {
        let tree = Tree::new();
        os::faults::STATE.with(|state| {
            let mut state = state.borrow_mut();
            if name == "partial" {
                state.partial_write = true;
            } else if name == "write" {
                state.fail_write = true;
            } else {
                state.fail_close = Some(name);
                state.close_after_write = true;
                state.first_leaf_only = name == "laptop";
            }
        });
        assert_eq!(tree.apply(|| Ok(true), future()), Err(Failure::Unconfirmed));
        tree.assert_no_fds();
        os::faults::STATE.with(|state| {
            assert!(state.borrow().written);
            assert_eq!(state.borrow().write_calls, 1);
        });
    }
}
#[test]
fn failed_open_metadata_and_parent_close_never_leak_or_reach_writer() {
    for fail in ["open", "metadata", "close"] {
        let tree = Tree::new();
        os::faults::STATE.with(|state| {
            let mut state = state.borrow_mut();
            match fail {
                "open" => state.fail_open = Some("laptop"),
                "metadata" => state.fail_metadata = true,
                _ => state.fail_close = Some("system.slice"),
            }
        });
        assert_eq!(
            tree.apply(|| Ok(true), future()),
            Err(Failure::Refused("IDENTITY_MISMATCH"))
        );
        assert_eq!(tree.high(), "max");
        tree.assert_no_fds();
        os::faults::STATE.with(|state| assert!(!state.borrow().written));
    }
}
#[test]
fn symlinked_cgroup_leaf_or_memory_file_never_reaches_writer() {
    for leaf in [false, true] {
        let tree = Tree::new();
        let other = tree.root.join("other");
        fs::create_dir(&other).unwrap();
        if leaf {
            fs::remove_file(tree.leaf.join("memory.max")).unwrap();
            fs::remove_file(tree.leaf.join("memory.high")).unwrap();
            fs::remove_dir(&tree.leaf).unwrap();
            symlink(&other, &tree.leaf).unwrap();
        } else {
            fs::remove_file(tree.leaf.join("memory.max")).unwrap();
            symlink(other.join("max"), tree.leaf.join("memory.max")).unwrap();
        }
        assert!(matches!(
            tree.apply(|| Ok(true), future()),
            Err(Failure::Refused(_))
        ));
        tree.assert_no_fds();
    }
}
#[test]
fn wrong_peer_is_refused_before_reading_policy_request_or_engine() {
    let tree = Tree::new();
    let (mut server, _client) = UnixStream::pair().unwrap();
    assert_eq!(
        serve(&mut server, &tree.pins()),
        Reply::Refusal {
            ok: false,
            code: "PEER_REFUSED"
        }
    );
    assert_eq!(tree.high(), "max");
}
#[test]
fn socket_frames_are_bounded_and_fragments_never_extend_deadline() {
    let (mut server, mut client) = UnixStream::pair().unwrap();
    client.write_all(&request()).unwrap();
    assert!(read_request(&mut server, future()).is_ok());
    let (mut server, mut client) = UnixStream::pair().unwrap();
    let mut twice = request();
    twice.extend(request());
    client.write_all(&twice).unwrap();
    assert_eq!(
        read_request(&mut server, future()).unwrap_err(),
        Failure::Refused("REQUEST_INVALID")
    );
    let (mut server, mut client) = UnixStream::pair().unwrap();
    client.write_all(b"{").unwrap();
    let start = Instant::now();
    assert_eq!(
        read_request(&mut server, start + Duration::from_millis(15)).unwrap_err(),
        Failure::Refused("REQUEST_INVALID")
    );
    assert!(start.elapsed() < Duration::from_millis(200));
}

fn run_fixture<F: FnMut(&Pins, &str, Instant) -> Result<EngineRow>>(
    tree: &Tree,
    raw: &[u8],
    inspector: F,
) -> Reply {
    let (mut server, mut client) = UnixStream::pair().unwrap();
    client.write_all(raw).unwrap();
    let mut pins = tree.pins();
    pins.broker_uid = peer_uid(&server).unwrap();
    fs::write(
        &pins.policy,
        serde_json::to_vec(&tree.policy_value()).unwrap(),
    )
    .unwrap();
    let host = Host {
        proc: &tree.proc,
        cgroup: &tree.cgroup,
        policy_anchor: &tree.root,
        policy_uid: fs::metadata(&tree.root).unwrap().uid(),
    };
    let response = reply(run_request(&mut server, &pins, &host, inspector));
    let mut wire = serde_json::to_vec(&response).unwrap();
    wire.push(b'\n');
    server.write_all(&wire).unwrap();
    let mut received = vec![0; wire.len()];
    client.read_exact(&mut received).unwrap();
    assert_eq!(received, wire);
    response
}
#[test]
fn authorized_socket_request_applies_only_owner_policy_and_reports_exact_reply() {
    let tree = Tree::new();
    let mut calls = 0;
    let response = run_fixture(&tree, &request(), |_, name, _| {
        calls += 1;
        assert_eq!(name, format!("reverie-agent-{SID}"));
        Ok(tree.row())
    });
    assert_eq!(
        response,
        Reply::Success {
            ok: true,
            high: 1024 * MIB
        }
    );
    assert_eq!(calls, 3);
    assert_eq!(tree.high(), (1024 * MIB).to_string());
    tree.assert_no_fds();
}
#[test]
fn serve_identity_drift_and_kernel_refusal_preserve_write_classification() {
    for change_at in [2, 3] {
        let tree = Tree::new();
        let mut calls = 0;
        let response = run_fixture(&tree, &request(), |_, _, _| {
            calls += 1;
            let mut row = tree.row();
            if calls == change_at {
                row.state.pid = 4343;
            }
            Ok(row)
        });
        let code = if change_at == 2 {
            "IDENTITY_MISMATCH"
        } else {
            "EFFECT_UNCONFIRMED"
        };
        assert_eq!(response, Reply::Refusal { ok: false, code });
        assert_eq!(
            tree.high(),
            if change_at == 2 {
                "max".into()
            } else {
                (1024 * MIB).to_string()
            }
        );
        tree.assert_no_fds();
    }
    let tree = Tree::new();
    fs::write(
        tree.proc.join("sys/kernel/osrelease"),
        "\u{2003}6.18.39\u{2003}\n",
    )
    .unwrap();
    assert_eq!(
        run_fixture(&tree, &request(), |_, _, _| panic!("engine must not run")),
        Reply::Refusal {
            ok: false,
            code: "KERNEL_UNQUALIFIED"
        }
    );
    assert_eq!(tree.high(), "max");
}
#[test]
fn malformed_socket_request_never_reads_policy_or_invokes_engine() {
    let tree = Tree::new();
    let mut raw = request();
    raw.extend(request());
    assert_eq!(
        run_fixture(&tree, &raw, |_, _, _| panic!("engine must not run")),
        Reply::Refusal {
            ok: false,
            code: "REQUEST_INVALID"
        }
    );
    assert_eq!(tree.high(), "max");
}
#[test]
fn dribbling_socket_fragments_do_not_renew_the_original_deadline() {
    let (mut server, mut client) = UnixStream::pair().unwrap();
    let writer = std::thread::spawn(move || {
        for _ in 0..12 {
            std::thread::sleep(Duration::from_millis(20));
            if client.write_all(b" ").is_err() {
                break;
            }
        }
    });
    let start = Instant::now();
    assert_eq!(
        read_request(&mut server, start + Duration::from_millis(45)).unwrap_err(),
        Failure::Refused("REQUEST_INVALID")
    );
    assert!(start.elapsed() < Duration::from_millis(180));
    drop(server);
    writer.join().unwrap();
}
fn engine_script(tree: &Tree, body: &str) -> Pins {
    let mut pins = tree.pins();
    pins.engine = tree
        .root
        .join(format!("engine-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    let shell = std::env::var("REVERIE_TEST_SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&pins.engine)
        .unwrap();
    file.write_all(format!("#!{shell}\n{body}\n").as_bytes())
        .unwrap();
    file.sync_all().unwrap();
    os::close(file.into()).unwrap();
    pins
}
#[test]
fn engine_subprocess_output_and_deadline_are_bounded() {
    let _exclusive = ENGINE_FIXTURES.lock().unwrap();
    for sink in ["", " >&2"] {
        let tree = Tree::new();
        let pins = engine_script(
            &tree,
            &format!("i=0; while [ \"$i\" -lt 17000 ]; do printf 'xxxx'{sink}; i=$((i+1)); done"),
        );
        assert_eq!(
            inspect(&pins, "owned-fixture", future()).unwrap_err(),
            Failure::Refused("IDENTITY_MISMATCH")
        );
        tree.assert_no_fds();
    }
    let tree = Tree::new();
    let pins = engine_script(&tree, "while :; do :; done");
    let start = Instant::now();
    assert_eq!(
        inspect(&pins, "owned-fixture", start + Duration::from_millis(20)).unwrap_err(),
        Failure::Refused("DEADLINE")
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    tree.assert_no_fds();
}
#[test]
fn engine_subprocess_accepts_only_successful_valid_structured_identity() {
    let _exclusive = ENGINE_FIXTURES.lock().unwrap();
    let tree = Tree::new();
    let row = serde_json::json!({"Id":CID,"Name":format!("/reverie-agent-{SID}"),"Config":{"Labels":{"reverie.worker":"reverie","reverie.session":SID}},
        "State":{"Running":true,"Pid":4242},"Mounts":[{"Type":"bind","Source":tree.home,"Destination":"/home/agent"}],"HostConfig":{"Memory":4096*MIB}});
    let pins = engine_script(&tree, &format!("printf '%s' '{}'", row));
    assert_eq!(
        inspect(&pins, "owned-fixture", future()).unwrap(),
        tree.row()
    );
    for bad in ["printf 'not json'", "printf '{}'; exit 1"] {
        let pins = engine_script(&tree, bad);
        assert_eq!(
            inspect(&pins, "owned-fixture", future()).unwrap_err(),
            Failure::Refused("IDENTITY_MISMATCH")
        );
    }
    tree.assert_no_fds();
}
