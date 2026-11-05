use crate::StoreError;
use crate::faults::{self, Point};
use crate::profiles::ProfileStore;
use reverie_contracts::profiles_v1;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::profiles::{ProfileBinding, ProfileDocument, ProfilePutIntent};
use reverie_core::resources::{BudgetMode, CpuQuota, ResourcePolicy};
use reverie_core::revision::{Generation, ObservedProfileVersion, StoreRevision};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

mod failures;
mod locked_read;
mod storage;
mod threaded;

const E: &str = "11111111-1111-4111-8111-111111111111";
const F: &str = "22222222-2222-4222-8222-222222222222";
const A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        faults::reset();
        let root = std::env::temp_dir().join(format!(
            "reverie-profile-store-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root }
    }
    fn open(&self) -> ProfileStore {
        ProfileStore::open(&self.root).unwrap()
    }
    fn data(&self) -> PathBuf {
        self.root.join("profiles.json")
    }
    fn raw(&self) -> Vec<u8> {
        fs::read(self.data()).unwrap()
    }
    fn write(&self, raw: &[u8]) {
        fs::write(self.data(), raw).unwrap();
        fs::set_permissions(self.data(), fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn save(&self) -> ProfileStore {
        let store = self.open();
        store.put(&new_intent()).unwrap();
        store
    }
    fn temporaries(&self) -> Vec<PathBuf> {
        fs::read_dir(&self.root)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".profiles-")
            })
            .map(|entry| entry.path())
            .collect()
    }
    fn fd_count(&self) -> usize {
        fs::read_dir("/proc/self/fd")
            .unwrap()
            .flatten()
            .filter(|entry| {
                fs::read_link(entry.path()).is_ok_and(|path| path.starts_with(&self.root))
            })
            .count()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        faults::reset();
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn resources(memory: u32) -> ResourcePolicy {
    ResourcePolicy::try_new(
        BudgetMode::Admission,
        memory,
        512,
        CpuQuota::from_integer(0).unwrap(),
        49152,
        8192,
    )
    .unwrap()
}
fn binding(employee: &str, current: &str, target: &str) -> ProfileBinding {
    ProfileBinding::try_new(
        ProfileEmployeeId::parse(employee).unwrap(),
        ProfileSessionId::parse(current).unwrap(),
        ProfileSessionId::parse(target).unwrap(),
        Generation::try_new(1).unwrap(),
        Generation::try_new(2).unwrap(),
    )
    .unwrap()
}
fn intent(
    employee: &str,
    memory: u32,
    revision: u64,
    version: u64,
    previous: Option<ProfileBinding>,
) -> ProfilePutIntent {
    ProfilePutIntent::try_new(
        ProfileEmployeeId::parse(employee).unwrap(),
        resources(memory),
        binding(employee, A, B),
        StoreRevision::try_new(revision).unwrap(),
        ObservedProfileVersion::try_new(version).unwrap(),
        previous,
    )
    .unwrap()
}
fn new_intent() -> ProfilePutIntent {
    intent(E, 38147, 0, 0, None)
}
fn next_intent() -> ProfilePutIntent {
    intent(E, 8192, 1, 1, Some(binding(E, A, B)))
}
fn inject<F: FnMut(Point, &Path) -> crate::error::Result<()> + 'static>(hook: F) {
    faults::STATE.with(|state| state.borrow_mut().hook = Some(Box::new(hook)));
}
fn injected() -> StoreError {
    StoreError::io(std::io::Error::other("owned fixture fault"))
}
fn assert_pre_refusal(result: Result<ProfileDocument, StoreError>) -> StoreError {
    let error = result.unwrap_err();
    assert!(!error.is_uncertain(), "{error:?}");
    error
}
