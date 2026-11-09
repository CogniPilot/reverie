use super::*;
use crate::{faults, private_fs};
use reverie_core::ids::ProfileSessionId;
use std::cell::RefCell;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

mod compatibility;
mod custody;
mod provider;
mod resolution;

pub(super) enum Point {
    BeforeRead,
    AfterRead,
    CurrentSelected,
}
type Hook = Box<dyn FnMut(Point, &Path) -> Result<()>>;
thread_local! { static HOOK:RefCell<Option<Hook>>=RefCell::new(None); }
pub(super) fn hit(point: Point, path: &Path) -> Result<()> {
    let Some(mut hook) = HOOK.with(|value| value.borrow_mut().take()) else {
        return Ok(());
    };
    let result = hook(point, path);
    HOOK.with(|value| *value.borrow_mut() = Some(hook));
    result
}
fn inject(hook: impl FnMut(Point, &Path) -> Result<()> + 'static) {
    HOOK.with(|value| *value.borrow_mut() = Some(Box::new(hook)));
}
const E: &str = "11111111-2222-4333-8444-555555555555";
const F: &str = "22222222-2222-4333-8444-555555555555";
const A: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const B: &str = "99999999-8888-4777-8666-555555555555";
const C: &str = "12345678-1234-4234-8234-123456789abc";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        faults::reset();
        let root = std::env::temp_dir().join(format!(
            "reverie-storage-identity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let tree = Self { root };
        tree.company(&[row(E, A, "1", "true", "false")], &[]);
        tree
    }
    fn company_file(&self) -> PathBuf {
        self.root.join("company.json")
    }
    fn state(&self) -> PathBuf {
        self.root.join("state")
    }
    fn config(&self) -> StorageIdentityConfig {
        StorageIdentityConfig::try_new(
            self.company_file(),
            self.state(),
            self.root.join("scratch"),
            uid(),
        )
        .unwrap()
    }
    fn company(&self, current: &[String], retired: &[String]) {
        self.write(
            &self.company_file(),
            &format!(
                "{{\"employees\":[{}],\"retired\":[{}]}}",
                current.join(","),
                retired.join(",")
            ),
        );
    }
    fn write(&self, path: &Path, value: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, value).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn journal(&self, employee: &str, owner: &str, phase: &str) {
        self.write(&self.root.join("plan-moves.json"),&format!("[{{\"employeeId\":\"{employee}\",\"owner\":{owner},\"oldSession\":\"{A}\",\"newSession\":\"{B}\",\"phase\":\"{phase}\"}}]"));
    }
    fn marker(&self, session: &str, employee: &str, owner: &str) {
        self.write(&self.state().join(session).join("storage-owner.json"),&format!("{{\"version\":1,\"employeeId\":\"{employee}\",\"sessionId\":\"{session}\",\"owner\":{owner}}}"));
    }
    fn fd_count(&self) -> usize {
        fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
            .filter(|path| path.starts_with(&self.root))
            .count()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        HOOK.with(|value| *value.borrow_mut() = None);
        faults::reset();
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn uid() -> u32 {
    fs::metadata("/proc/self").unwrap().uid()
}
use std::os::unix::fs::MetadataExt;
fn session(value: &str) -> ProfileSessionId {
    ProfileSessionId::parse(value).unwrap()
}
fn row(employee: &str, session: &str, generation: &str, running: &str, vacation: &str) -> String {
    format!(
        "{{\"id\":\"{employee}\",\"sessionId\":\"{session}\",\"owner\":\"owner-a\",\"sessionGeneration\":{generation},\"desiredRunning\":{running},\"onVacation\":{vacation}}}"
    )
}
