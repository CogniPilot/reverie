//! Test-only effect owner for the reviewed disposable Docker hierarchy. It
//! never creates an InstalledWorkerPool or a routine maintenance permission.
use super::*;

#[derive(Eq, PartialEq)]
enum Stage {
    Ready,
    Attempted,
    Configured,
    Closed,
}

pub(in crate::worker_pool) struct OwnedLimitFixture {
    policy: WorkerPoolPolicy,
    directory: PoolDirectory,
    anchor: String,
    pid: u32,
    policy_file: Option<File>,
    stage: Stage,
    leaves: Vec<Leaf>,
}
struct Leaf {
    id: String,
    pid: u32,
    start: String,
    directory: Option<File>,
    high: u64,
}
impl OwnedLimitFixture {
    pub(in crate::worker_pool) fn acquire(
        policy: WorkerPoolPolicy,
        policy_file: File,
        anchor: String,
        pid: u32,
    ) -> Self {
        assert!(
            policy
                .deployment
                .strip_prefix("poolfixture")
                .is_some_and(|suffix| {
                    suffix.len() == 16 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
        );
        assert!(reverie_contracts::worker_pool::hex_id(&anchor));
        let directory = PoolDirectory::unopened(&policy);
        // Retain every opened owner before any fallible native acquisition.
        let mut owner = Self {
            policy,
            directory,
            anchor,
            pid,
            policy_file: Some(policy_file),
            stage: Stage::Ready,
            leaves: Vec::with_capacity(2),
        };
        owner
            .directory
            .acquire(&owner.policy, &owner.anchor, owner.pid)
            .unwrap();
        owner
    }

    pub(in crate::worker_pool) fn configure(&mut self) {
        assert!(self.stage == Stage::Ready);
        self.stage = Stage::Attempted;
        self.directory
            .assert_anchor_only(&self.anchor, self.pid)
            .unwrap();
        self.directory.configure(&self.policy).unwrap();
        self.stage = Stage::Configured;
        self.observe();
    }

    pub(in crate::worker_pool) fn add_leaf(&mut self, id: String, pid: u32) {
        assert!(self.stage == Stage::Configured && self.leaves.len() < 2);
        assert!(reverie_contracts::worker_pool::hex_id(&id));
        assert!(id != self.anchor && self.leaves.iter().all(|leaf| leaf.id != id));
        // Check parent limits BEFORE any leaf write. A Docker/systemd reset
        // is a failed witness, never permission to silently reapply the parent.
        self.observe();
        let high = [512_u64, 1024][self.leaves.len()] * 1_048_576;
        let file = native::open_at(
            self.directory.parent().unwrap().as_raw_fd(),
            OsStr::new(&format!("docker-{id}.scope")),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )
        .unwrap();
        self.leaves.push(Leaf {
            id,
            pid,
            start: String::new(),
            directory: Some(file),
            high,
        });
        let leaf = self.leaves.last_mut().unwrap();
        leaf.start = process_start(pid).unwrap();
        leaf.assert_current(&self.directory.name);
        write_at(
            leaf.directory.as_ref().unwrap(),
            "memory.high",
            high.to_string().as_bytes(),
        )
        .unwrap();
        // CpuShares is not cgroup-v2 cpu.weight. Set and read the actual
        // purpose-owned leaf weight rather than infer it from Docker DATA.
        write_at(leaf.directory.as_ref().unwrap(), "cpu.weight", b"100").unwrap();
        self.observe();
    }

    pub(in crate::worker_pool) fn observe(&self) {
        assert!(self.stage == Stage::Configured);
        self.directory
            .assert_anchor_current(&self.anchor, self.pid)
            .unwrap();
        self.directory.assert_limits(&self.policy).unwrap();
        print_limits("PARENT", self.directory.parent().unwrap());
        for leaf in &self.leaves {
            leaf.assert_current(&self.directory.name);
            leaf.assert_limits(&self.policy, &self.directory.memory_nodes);
            print_limits(&leaf.id, leaf.directory.as_ref().unwrap());
        }
    }

    pub(in crate::worker_pool) fn reopen_with_running_leaves(&mut self, birth: &JournalDigest) {
        assert!(self.stage == Stage::Configured && self.leaves.len() == 2);
        let anchor = ContainerId::parse(&self.anchor).unwrap();
        let retained = self
            .directory
            .retained_anchor_data(&anchor, self.pid, birth)
            .unwrap();
        self.directory.close().unwrap();
        self.directory = PoolDirectory::unopened(&self.policy);
        let discovered = self
            .directory
            .observe_retained(&self.policy, &anchor, self.pid, birth)
            .unwrap();
        assert_eq!(discovered, retained);
        self.observe();
        self.directory.close().unwrap();
        self.directory = PoolDirectory::unopened(&self.policy);
        self.directory
            .acquire_retained(&self.policy, &retained)
            .unwrap();
        self.observe();
    }

    pub(in crate::worker_pool) fn close(&mut self) {
        self.observe();
        assert_eq!(self.leaves.len(), 2);
        for leaf in &mut self.leaves {
            native::close(leaf.directory.take().unwrap()).unwrap();
        }
        self.directory.close().unwrap();
        native::close(self.policy_file.take().unwrap()).unwrap();
        self.stage = Stage::Closed;
    }
}
impl Drop for OwnedLimitFixture {
    fn drop(&mut self) {
        if self.stage != Stage::Closed {
            // A panic is negative. Preserve actual native owners for the
            // remainder of the isolated child; the parent retains containers.
            for leaf in &mut self.leaves {
                std::mem::forget(leaf.directory.take());
            }
            std::mem::forget(self.policy_file.take());
            let directory =
                std::mem::replace(&mut self.directory, PoolDirectory::unopened(&self.policy));
            std::mem::forget(directory);
        }
    }
}

impl Leaf {
    fn assert_current(&self, parent: &str) {
        let expected = format!("0::/{parent}/docker-{}.scope\n", self.id);
        assert_eq!(
            bounded_path(&format!("/proc/{}/cgroup", self.pid), 4096).unwrap(),
            expected
        );
        assert_eq!(process_start(self.pid).unwrap(), self.start);
        let file = self.directory.as_ref().unwrap();
        assert_eq!(
            read_at(file, "cgroup.procs").unwrap(),
            format!("{}\n", self.pid)
        );
        let named = native::open_at(
            nix::libc::AT_FDCWD,
            OsStr::new(&format!("/sys/fs/cgroup/{parent}/docker-{}.scope", self.id)),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )
        .unwrap();
        assert_eq!(identity(&named).unwrap(), identity(file).unwrap());
        native::close(named).unwrap();
    }
    fn assert_limits(&self, policy: &WorkerPoolPolicy, nodes: &[u32]) {
        let file = self.directory.as_ref().unwrap();
        for (name, expected) in [
            ("memory.max", "51539607552".into()),
            ("memory.high", self.high.to_string()),
            ("memory.swap.max", "0".into()),
            ("pids.max", "512".into()),
            ("cpu.max", "max 100000".into()),
            ("cpu.weight", "100".into()),
        ] {
            assert_eq!(read_at(file, name).unwrap().trim(), expected, "{name}");
        }
        for name in ["cpuset.cpus", "cpuset.cpus.effective"] {
            assert_eq!(
                parse_cpus(read_at(file, name).unwrap().trim()).unwrap(),
                policy.allowed_cpus
            );
        }
        for name in ["cpuset.mems", "cpuset.mems.effective"] {
            assert_eq!(
                parse_cpus(read_at(file, name).unwrap().trim()).unwrap(),
                nodes
            );
        }
        self.assert_current(&policy.parent_cgroup_relative());
    }
}
fn print_limits(label: &str, file: &File) {
    let mut data = serde_json::Map::new();
    for name in [
        "memory.max",
        "memory.high",
        "memory.swap.max",
        "pids.max",
        "cpu.max",
        "cpu.weight",
        "cpuset.cpus",
        "cpuset.cpus.effective",
        "cpuset.mems",
        "cpuset.mems.effective",
    ] {
        data.insert(name.into(), read_at(file, name).unwrap().trim().into());
    }
    let (device, inode) = identity(file).unwrap();
    println!(
        "POOL_LIMITS {label} {device}:{inode} {}",
        serde_json::Value::Object(data)
    );
}
