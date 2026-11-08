use super::*;
use crate::native;
use std::{
    fs,
    io::{Read, Write},
    os::{
        fd::OwnedFd,
        unix::{fs::MetadataExt, net::UnixStream},
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

pub(super) fn run() {
    assert_eq!(nix::unistd::geteuid().as_raw(), 1000);
    assert_eq!(nix::unistd::getegid().as_raw(), 100);
    let status = fs::read_to_string("/proc/self/status").unwrap();
    for (name, expected) in [("CapEff:", 0), ("CapPrm:", 0), ("CapBnd:", 192)] {
        let value = status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .unwrap()
            .trim();
        assert_eq!(u64::from_str_radix(value, 16).unwrap(), expected, "{name}");
    }
    assert!(status.lines().any(|line| line == "Seccomp:\t2"));
    assert!(status.lines().any(|line| line == "NoNewPrivs:\t0"));
    assert_eq!(
        fs::read_to_string("/etc/subuid").unwrap().trim(),
        "agent:100000:65536"
    );
    assert_eq!(
        fs::read_to_string("/etc/subgid").unwrap().trim(),
        "agent:100000:65536"
    );
    println!("PERF_GUEST_READY uid=1000 gid=100 capeff=0 capprm=0 capbnd=192 seccomp=2 nnp=0");
    std::io::stdout().flush().unwrap();
    let mut start = [0];
    std::io::stdin().read_exact(&mut start).unwrap();
    assert_eq!(start, [b'R']);
    fs::create_dir("/tmp/perf-owned").unwrap();
    perf();
    let mut daemon = Daemon::spawn();
    daemon.ready();
    inner_native_workload(&daemon);
    daemon.close();
    println!(
        "PERF_ACCEPTANCE {}",
        serde_json::json!({"status":"passed","uid":1000,"policy":"task-v1","event":"task-clock:u","stat":true,"record":true,"report":true,"innerRootlessNativeWorkload":true,"innerWorkloadPerfProfiled":false})
    );
}
fn perf() {
    let exe = std::env::current_exe().unwrap();
    let workload = ["--ignored", "--exact", WORKLOAD, "--test-threads=1"];
    let mut stat = Command::new("/bin/perf");
    stat.args([
        "stat",
        "--no-big-num",
        "-x,",
        "--output",
        "/tmp/perf-owned/stat.csv",
        "--event",
        "task-clock:u",
        "--",
    ])
    .arg(&exe)
    .args(workload);
    docker::capture(&mut stat)
        .unwrap_or_else(|error| panic!("PERF_RUNTIME_REFUSED (not passed/skipped): {error}"));
    let raw = fs::read_to_string("/tmp/perf-owned/stat.csv").unwrap();
    assert!(
        !raw.contains("<not counted>") && !raw.contains("<not supported>"),
        "{raw}"
    );
    assert!(
        raw.lines()
            .filter(|line| line.contains("task-clock:u"))
            .any(|line| line
                .split(',')
                .next()
                .unwrap()
                .trim()
                .parse::<f64>()
                .is_ok_and(|value| value > 0.0)),
        "{raw}"
    );
    println!("ACTUAL_PERF_STAT {raw}");
    let mut record = Command::new("/bin/perf");
    record
        .args([
            "record",
            "--quiet",
            "--inherit",
            "--all-user",
            "--mmap-pages",
            "64",
            "--freq",
            "99",
            "--event",
            "task-clock:u",
            "--output",
            "/tmp/perf-owned/perf.data",
            "--",
        ])
        .arg(&exe)
        .args(workload);
    docker::capture(&mut record)
        .unwrap_or_else(|error| panic!("PERF_RECORD_REFUSED (not passed/skipped): {error}"));
    let report = docker::capture(Command::new("/bin/perf").args([
        "report",
        "--stdio",
        "--header",
        "--input",
        "/tmp/perf-owned/perf.data",
    ]))
    .unwrap();
    println!("ACTUAL_PERF_REPORT {report}");
    assert!(report.contains("task-clock:u"));
    assert!(
        report
            .lines()
            .filter_map(|line| line.strip_prefix("# Samples:"))
            .any(|line| line
                .trim_start()
                .starts_with(['1', '2', '3', '4', '5', '6', '7', '8', '9'])),
        "{report}"
    );
}

struct Daemon {
    child: Option<Child>,
    tools: PathBuf,
    kill_attempted: bool,
}
impl Daemon {
    fn spawn() -> Self {
        let tools = PathBuf::from(std::env::var_os("REVERIE_PERF_GUEST_TOOLS").unwrap());
        assert_eq!(tools.parent(), Some(std::path::Path::new("/nix/store")));
        let log = fs::File::create("/tmp/perf-owned/rootless-daemon.log").unwrap();
        let output = log.try_clone().unwrap();
        let error = log.try_clone().unwrap();
        let child = Command::new(tools.join("bin/dockerd-rootless"))
            .args([
                "--host=unix:///run/reverie-docker/docker.sock",
                "--data-root=/home/agent/owned-docker",
                "--exec-root=/run/reverie-docker/exec",
                "--pidfile=/run/reverie-docker/daemon.pid",
                "--iptables=false",
                "--ip-masq=false",
                "--bridge=none",
            ])
            .stdin(Stdio::null())
            .stdout(output)
            .stderr(error)
            .spawn()
            .unwrap();
        // The actual child is retained before subsequent validation/queries.
        let owner = Self {
            child: Some(child),
            tools,
            kill_attempted: false,
        };
        native::close(log).unwrap();
        owner
    }
    fn query(&self, args: &[&str]) -> Result<String, String> {
        docker::capture(
            Command::new(self.tools.join("bin/docker"))
                .args(["--host", "unix:///run/reverie-docker/docker.sock"])
                .args(args),
        )
    }
    fn ready(&mut self) {
        let end = Instant::now() + Duration::from_secs(60);
        let mut last = String::new();
        loop {
            assert!(
                self.child.as_mut().unwrap().try_wait().unwrap().is_none(),
                "rootless daemon exited: {}",
                fs::read_to_string("/tmp/perf-owned/rootless-daemon.log").unwrap()
            );
            if let Ok(raw) = self.query(&["info", "--format", "{{json .}}"]) {
                let info: serde_json::Value = serde_json::from_str(&raw).unwrap();
                assert_rootless_info(&info);
                let socket = fs::metadata("/run/reverie-docker/docker.sock").unwrap();
                assert_eq!(socket.uid(), 1000);
                verify_rootless_peer();
                println!("ACTUAL_ROOTLESS_INFO {raw}");
                return;
            } else if let Err(error) = self.query(&["version", "--format", "{{.Server.Version}}"]) {
                last = error;
            }
            assert!(
                Instant::now() < end,
                "actual rootless daemon unavailable: {last}; {}",
                fs::read_to_string("/tmp/perf-owned/rootless-daemon.log").unwrap()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    fn close(&mut self) {
        assert!(!self.kill_attempted);
        if self.child.as_mut().unwrap().try_wait().unwrap().is_none() {
            self.kill_attempted = true;
            self.child.as_mut().unwrap().kill().unwrap();
        }
        let end = Instant::now() + Duration::from_secs(5);
        while self.child.as_mut().unwrap().try_wait().unwrap().is_none() {
            assert!(Instant::now() < end, "actual daemon leader reap retained");
            std::thread::sleep(Duration::from_millis(5));
        }
        self.child = None;
        // This only settles the directly owned leader. The outer fixture must
        // still establish actual container exit/removal for remaining members.
    }
}
fn assert_rootless_info(info: &serde_json::Value) {
    assert!(
        info["SecurityOptions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| {
                value.as_str().is_some_and(|text| {
                    text == "name=rootless" || text.starts_with("name=rootless,")
                })
            })
    );
    assert_eq!(info["Driver"], "vfs");
}
fn verify_rootless_peer() {
    let stream = UnixStream::connect("/run/reverie-docker/docker.sock").unwrap();
    let peer =
        nix::sys::socket::getsockopt(&stream, nix::sys::socket::sockopt::PeerCredentials).unwrap();
    assert_eq!(peer.uid(), 1000);
    assert!(peer.pid() > 1);
    let uid = fs::read_to_string(format!("/proc/{}/uid_map", peer.pid())).unwrap();
    let gid = fs::read_to_string(format!("/proc/{}/gid_map", peer.pid())).unwrap();
    let rows = |raw: &str| {
        raw.lines()
            .map(|line| {
                line.split_whitespace()
                    .map(|v| v.parse::<u32>().unwrap())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(rows(&uid), vec![vec![0, 1000, 1], vec![1, 100000, 65536]]);
    assert_eq!(rows(&gid), vec![vec![0, 100, 1], vec![1, 100000, 65536]]);
    let fd: OwnedFd = stream.into();
    native::close(fs::File::from(fd)).unwrap();
    println!(
        "ACTUAL_ROOTLESS_KERNEL_PEER pid={} uid1000 uid_map={:?} gid_map={:?}",
        peer.pid(),
        uid,
        gid
    );
}
impl Drop for Daemon {
    fn drop(&mut self) {
        if self.child.is_some() {
            std::mem::forget(self.child.take());
        }
    }
}
fn inner_native_workload(daemon: &Daemon) {
    let core = PathBuf::from(std::env::var_os("REVERIE_PERF_GUEST_COREUTILS").unwrap());
    assert_eq!(core.parent(), Some(std::path::Path::new("/nix/store")));
    let raw = daemon
        .query(&[
            "import",
            "--change",
            &format!("ENTRYPOINT [\"{}\"]", core.join("bin/true").display()),
            "/run/reverie-perf-input/rootfs.tar",
            "owned-native-perf:fixture",
        ])
        .unwrap();
    assert!(raw.trim().starts_with("sha256:"));
    let inspected: serde_json::Value = serde_json::from_str(
        &daemon
            .query(&["image", "inspect", "owned-native-perf:fixture"])
            .unwrap(),
    )
    .unwrap();
    let id = inspected[0]["Id"].as_str().unwrap();
    assert!(
        id.strip_prefix("sha256:")
            .is_some_and(|value| reverie_core::ids::ContainerId::parse(value).is_ok())
    );
    assert_eq!(
        inspected[0]["Config"]["Entrypoint"],
        serde_json::json!([core.join("bin/true")])
    );
    let closure: Vec<PathBuf> =
        serde_json::from_slice(&fs::read("/run/reverie-perf-input/core-closure.json").unwrap())
            .unwrap();
    let mut args = vec![
        "create".into(),
        "--name".into(),
        "owned-native-perf-workload".into(),
        "--network".into(),
        "none".into(),
        "--read-only".into(),
        "--user".into(),
        "1000:100".into(),
    ];
    for path in closure {
        assert_eq!(path.parent(), Some(std::path::Path::new("/nix/store")));
        args.push("--mount".into());
        args.push(format!(
            "type=bind,src={},dst={},readonly",
            path.display(),
            path.display()
        ));
    }
    args.push(id.into());
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let cid = daemon.query(&borrowed).unwrap();
    let cid = cid.trim();
    assert!(reverie_core::ids::ContainerId::parse(cid).is_ok());
    daemon.query(&["start", "--attach", cid]).unwrap();
    let row: serde_json::Value =
        serde_json::from_str(&daemon.query(&["inspect", cid]).unwrap()).unwrap();
    assert_eq!(row[0]["Id"], cid);
    assert_eq!(row[0]["Image"], id);
    assert_eq!(row[0]["State"]["Running"], false);
    assert_eq!(row[0]["State"]["ExitCode"], 0);
    assert_eq!(row[0]["Config"]["User"], "1000:100");
    daemon.query(&["rm", cid]).unwrap();
    daemon
        .query(&["image", "rm", "owned-native-perf:fixture"])
        .unwrap();
    println!(
        "ACTUAL_INNER_NATIVE_WORKLOAD originalCID={cid} exit=0 user=1000:100 perfProfiled=false"
    );
}
