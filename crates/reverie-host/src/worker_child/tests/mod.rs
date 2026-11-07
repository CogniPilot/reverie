use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
};
mod processes;
mod records;
static NEXT: AtomicUsize = AtomicUsize::new(0);
static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
pub(super) fn program() -> &'static Path {
    PROGRAM.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("worker-child-build-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let source = root.join("child.rs");
        fs::write(
            &source,
            include_str!("../../../tests/support/worker_child_process.rs"),
        )
        .unwrap();
        let program = root.join("fixture");
        assert!(
            Command::new("rustc")
                .args(["--edition=2024"])
                .arg(&source)
                .arg("-o")
                .arg(&program)
                .status()
                .unwrap()
                .success()
        );
        program
    })
}
pub(super) struct Tree {
    pub(super) root: PathBuf,
}
impl Tree {
    pub(super) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "child-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root }
    }
    pub(super) fn record(&self, bytes: &[u8]) -> PathBuf {
        let path = self.root.join("launch.json");
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
pub(super) fn descriptors(path: &Path) -> usize {
    fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
        .filter(|entry| entry == path)
        .count()
}
