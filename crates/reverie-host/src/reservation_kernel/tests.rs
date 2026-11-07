use super::*;
use reverie_contracts::{reservation_engine::inventory_ids, worker_config};
use serde_json::json;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::{
    cell::RefCell,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
#[path = "tests_baseline.rs"]
mod baseline_cases;
#[path = "tests_custody.rs"]
mod custody_cases;
#[path = "tests_oracle.rs"]
mod oracle_cases;
#[path = "tests_source_release.rs"]
mod source_release_cases;
#[path = "tests_storage.rs"]
mod storage_cases;
type Hook = Box<dyn FnOnce(&Fixture, &PosixPath)>;
struct Fixture {
    root: PathBuf,
    hook: RefCell<Option<Hook>>,
    identity_hook: RefCell<Option<Hook>>,
    identity_paths: RefCell<std::collections::BTreeMap<Vec<u32>, PosixPath>>,
    mount_locations: RefCell<Vec<(PosixPath, UnsignedInteger, MountDevice)>>,
    scripted_reads:
        RefCell<std::collections::BTreeMap<Vec<u32>, std::collections::VecDeque<String>>>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-reservation-kernel-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let value = Self {
            root,
            hook: RefCell::new(None),
            identity_hook: RefCell::new(None),
            identity_paths: RefCell::new(std::collections::BTreeMap::new()),
            mount_locations: RefCell::new(Vec::new()),
            scripted_reads: RefCell::new(std::collections::BTreeMap::new()),
        };
        let stat = format!("1 (owned fixture) S {} 77", "0 ".repeat(18));
        for (name, raw) in [
            ("/proc/self/stat", stat.as_str()),
            ("/proc/123/stat", stat.as_str()),
            ("/proc/self/cgroup", "0::/observer\n"),
            ("/proc/123/cgroup", "0::/worker\n"),
            (
                "/proc/meminfo",
                "MemTotal: 16777216 kB\nMemAvailable: 12582912 kB\nSwapTotal: 1048576 kB\n",
            ),
            (
                "/proc/self/mountinfo",
                "1 0 0:1 / / rw - ext4 /dev/owned rw\n2 1 0:2 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
            ),
            ("/sys/fs/cgroup/cgroup.controllers", "memory pids\n"),
            ("/sys/fs/cgroup/observer/memory.current", "1\n"),
            ("/sys/fs/cgroup/observer/pids.current", "0\n"),
            ("/sys/fs/cgroup/memory.max", "max\n"),
            ("/sys/fs/cgroup/pids.max", "max\n"),
            ("/sys/fs/cgroup/worker/memory.max", "2147483648\n"),
            ("/sys/fs/cgroup/worker/pids.max", "128\n"),
            ("/sys/fs/cgroup/worker/memory.swap.max", "0\n"),
        ] {
            value.write(name, raw.as_bytes());
        }
        value
    }
    fn actual(&self, selected: &PosixPath) -> PathBuf {
        let native = native::python_path(&selected.codepoints()).unwrap();
        if let Ok(suffix) = native.strip_prefix("/proc") {
            return self.root.join("proc").join(suffix);
        }
        if let Ok(suffix) = native.strip_prefix(CGROUP) {
            return self.root.join("cgroup").join(suffix);
        }
        native
    }
    fn write(&self, name: &str, raw: &[u8]) {
        let p = self.actual(&path(name));
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, raw).unwrap();
    }
    fn row(&self) -> InventoryRows {
        self.row_with_mounts(json!([]))
    }
    fn row_with_mounts(&self, mounts: serde_json::Value) -> InventoryRows {
        let id = "1".repeat(64);
        let row = json!({"Id":id,"Name":"/office-agent","Image":format!("sha256:{}","a".repeat(64)),"Config":{"Labels":{"reverie.worker":"office"}},"State":{"Running":true,"Pid":123},"Mounts":mounts,"HostConfig":{"Memory":2147483648u64,"MemorySwap":2147483648u64,"PidsLimit":128,"NanoCpus":0}});
        InventoryRows::decode(&inventory_ids(&id).unwrap(), &[row.to_string()]).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
impl Source for Fixture {
    fn read(&self, p: &PosixPath, max: usize) -> Result<Vec<u8>> {
        if let Some(values) = self.scripted_reads.borrow_mut().get_mut(&p.codepoints()) {
            let value = if values.len() > 1 {
                values.pop_front().unwrap()
            } else {
                values[0].clone()
            };
            fs::write(self.actual(p), value).unwrap();
        }
        let raw = native::read_reservation(&self.actual(p), max)?;
        let hook = self.hook.borrow_mut().take();
        if let Some(hook) = hook {
            hook(self, p);
        }
        Ok(raw)
    }
    fn exists(&self, p: &PosixPath) -> Result<bool> {
        Installed.exists(&PosixPath::try_new(&native::python_text(&self.actual(p))).unwrap())
    }
    fn resolve(&self, p: &PosixPath) -> Result<PosixPath> {
        Ok(native::resolve_strict_text(&p.codepoints())?)
    }
    fn identity(&self, p: &PosixPath) -> Result<[u64; 4]> {
        let mapped = self
            .identity_paths
            .borrow()
            .get(&p.codepoints())
            .cloned()
            .unwrap_or_else(|| PosixPath::try_new(&native::python_text(&self.actual(p))).unwrap());
        let result = native::reservation_identity(&mapped)?;
        let hook = self.identity_hook.borrow_mut().take();
        if let Some(hook) = hook {
            hook(self, p);
        }
        Ok(result)
    }
    fn identity_text(&self, points: &[u32]) -> Result<[u64; 4]> {
        let raw = native::python_path(points)?;
        let selected = if raw.starts_with("/proc") || raw.starts_with(CGROUP) {
            self.actual(&PosixPath::try_new(points).unwrap())
        } else {
            raw
        };
        Ok(native::reservation_identity_text(&native::python_text(
            &selected,
        ))?)
    }
    fn resolve_optional(&self, p: &PosixPath) -> Result<PosixPath> {
        Ok(native::resolve_optional_text(&p.codepoints())?)
    }
    fn location(&self, p: &PosixPath) -> Result<(UnsignedInteger, MountDevice)> {
        if let Some((_, id, device)) = self
            .mount_locations
            .borrow()
            .iter()
            .filter(|(point, _, _)| p.is_relative_to(point))
            .max_by_key(|(point, _, _)| point.codepoints().len())
        {
            return Ok((id.clone(), device.clone()));
        }
        let cgroup = p.is_relative_to(&path(CGROUP));
        Ok((
            UnsignedInteger::from_u64(if cgroup { 2 } else { 1 }),
            MountDevice::from_native(0, if cgroup { 2 } else { 1 }),
        ))
    }
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
#[test]
fn full_host_root_and_container_controller_readback_use_owned_kernel_facts() {
    let fixture = Fixture::new();
    let accounting = host_root(&fixture, end()).unwrap();
    assert_eq!(accounting.total().as_str(), "17179869184");
    let rows = fixture.row();
    let observed = limits::observe(&fixture, &rows.rows()[0], None, end()).unwrap();
    let data: serde_json::Value =
        serde_json::from_slice(&observed.binding().canonical_bytes()).unwrap();
    assert_eq!(data["start"], "77");
    assert_eq!(data["cgroup"], "worker");
    assert_eq!(data["memory"], 2147483648u64);
    assert!(data.get("swapBytes").is_none());
    fs::remove_file(fixture.actual(&path("/sys/fs/cgroup/memory.max"))).unwrap();
    fs::remove_file(fixture.actual(&path("/sys/fs/cgroup/pids.max"))).unwrap();
    assert!(limits::observe(&fixture, &rows.rows()[0], None, end()).is_ok());
    fs::remove_file(fixture.actual(&path("/sys/fs/cgroup/worker/memory.max"))).unwrap();
    assert!(limits::observe(&fixture, &rows.rows()[0], None, end()).is_err());
}
#[test]
fn namespaced_hierarchy_missing_observer_counter_and_invalid_accounting_never_become_free_capacity()
{
    let fixture = Fixture::new();
    fixture.write("/sys/fs/cgroup/memory.current", b"1");
    assert!(host_root(&fixture, end()).is_err());
    fs::remove_file(fixture.actual(&path("/sys/fs/cgroup/memory.current"))).unwrap();
    fixture.write("/proc/meminfo", b"MemTotal: 10 kB\nMemAvailable: 11 kB\n");
    assert!(host_root(&fixture, end()).is_err());
    fixture.write("/proc/meminfo", b"MemTotal: 10 kB\nMemAvailable: 1 kB\n");
    fs::remove_file(fixture.actual(&path("/sys/fs/cgroup/observer/pids.current"))).unwrap();
    assert!(host_root(&fixture, end()).is_err());
}
#[test]
fn lower_ancestor_soft_swap_and_pid_drift_refuse() {
    let fixture = Fixture::new();
    let rows = fixture.row();
    fixture.write("/sys/fs/cgroup/memory.max", b"1073741824\n");
    assert!(limits::observe(&fixture, &rows.rows()[0], None, end()).is_err());
    fixture.write("/sys/fs/cgroup/memory.max", b"max\n");
    fixture.write("/sys/fs/cgroup/worker/memory.high", b"max\n");
    let effective = worker_config::decode(
        br#"{"memoryMiB":2048,"laptopMemoryPolicy":{"swapMiB":0,"memoryHighMiB":1024}}"#,
    )
    .unwrap();
    let policy = ObservedMemoryPolicy::from_effective(&effective)
        .unwrap()
        .unwrap();
    assert!(limits::observe(&fixture, &rows.rows()[0], Some(&policy), end()).is_err());
    fixture.write("/sys/fs/cgroup/worker/memory.high", b"1073741824\n");
    assert!(limits::observe(&fixture, &rows.rows()[0], Some(&policy), end()).is_ok());
    *fixture.hook.borrow_mut() = Some(Box::new(|fixture, _| {
        fixture.write(
            "/proc/123/stat",
            format!("1 (changed) S {} 78", "0 ".repeat(18)).as_bytes(),
        )
    }));
    assert!(limits::observe(&fixture, &rows.rows()[0], None, end()).is_err());
}
#[test]
fn owned_real_opath_metadata_keeps_all_fields_and_refuses_leaf_symlinks_and_close_failure() {
    let fixture = Fixture::new();
    let directory = fixture.root.join("owned");
    fs::create_dir(&directory).unwrap();
    let selected = PosixPath::try_new(&native::python_text(&directory)).unwrap();
    let expected = fs::metadata(&directory).unwrap();
    assert_eq!(
        native::reservation_identity(&selected).unwrap(),
        [
            expected.dev(),
            expected.ino(),
            u64::from(expected.uid()),
            u64::from(expected.gid())
        ]
    );
    let alias = fixture.root.join("alias");
    std::os::unix::fs::symlink(&directory, &alias).unwrap();
    assert!(
        native::reservation_identity(&PosixPath::try_new(&native::python_text(&alias)).unwrap())
            .is_err()
    );
    native::test_faults::set(None, true);
    assert!(native::reservation_identity(&selected).is_err());
    assert!(native::reservation_location(&selected).is_ok());
}
#[test]
#[ignore = "explicit read-only qualification requires the installed whole-host cgroup hierarchy"]
fn qualified_installed_host_root_is_read_from_fixed_proc_and_cgroup_paths() {
    let facts = ReservationKernel::new()
        .host_root(Instant::now() + Duration::from_secs(30))
        .unwrap();
    assert!(!facts.total().is_zero());
    assert!(!facts.available().is_zero());
    assert!(facts.available() <= facts.total());
    println!(
        "{{\"totalBytes\":\"{}\",\"availableBytes\":\"{}\"}}",
        facts.total().as_str(),
        facts.available().as_str()
    );
}
