use super::*;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
mod helper;
mod target;
mod workflow;
static NEXT: AtomicU64 = AtomicU64::new(0);
pub(super) struct KernelFixture {
    pub(super) root: PathBuf,
}
impl KernelFixture {
    pub(super) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "started-memory-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir_all(root.join("proc/321")).unwrap();
        fs::create_dir_all(root.join("cgroup/laptop")).unwrap();
        fs::write(
            root.join("proc/321/stat"),
            format!(
                "321 (owned process with spaces) {}\n",
                [vec!["S"; 19], vec!["123"]].concat().join(" ")
            ),
        )
        .unwrap();
        fs::write(root.join("proc/321/cgroup"), "0::/laptop\n").unwrap();
        for (name, value) in [
            ("memory.max", "2147483648\n"),
            ("memory.high", "max\n"),
            ("memory.swap.max", "0\n"),
        ] {
            fs::write(root.join("cgroup/laptop").join(name), value).unwrap();
        }
        Self { root }
    }
    pub(super) fn target(&self) -> super::target::Target {
        super::target::Target::capture(321, &self.root.join("proc"), &self.root.join("cgroup"))
            .unwrap()
    }
    fn set(&self, path: &str, value: &str) {
        fs::write(self.root.join(path), value).unwrap();
    }
}
impl Drop for KernelFixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
