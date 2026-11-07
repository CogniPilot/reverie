use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::{Command, Output},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};
static NEXT: AtomicU64 = AtomicU64::new(0);
static CHILD: OnceLock<PathBuf> = OnceLock::new();
fn child() -> &'static PathBuf {
    CHILD.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("autoenv-child-build-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("child.rs"), include_str!("autoenv_child.rs")).unwrap();
        let output = Command::new("rustc")
            .arg("--edition=2024")
            .arg(root.join("child.rs"))
            .arg("-o")
            .arg(root.join("child"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        root.join("child")
    })
}
pub(crate) struct Fixture {
    pub(crate) root: PathBuf,
    pub(crate) shim: PathBuf,
    pub(crate) plain: PathBuf,
    pub(crate) cached: PathBuf,
    pub(crate) repo: PathBuf,
    pub(crate) config: PathBuf,
    pub(crate) cache: PathBuf,
}
impl Fixture {
    pub(crate) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "autoenv-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let value = Self {
            shim: root.join("shim"),
            plain: root.join("plain"),
            cached: root.join("cached"),
            repo: root.join("repo"),
            config: root.join("approved"),
            cache: root.join("cache"),
            root,
        };
        for directory in [&value.shim, &value.plain, &value.cached, &value.repo] {
            fs::create_dir(directory).unwrap();
        }
        fs::write(value.repo.join("flake.nix"), b"owned flake\n").unwrap();
        fs::write(value.repo.join("flake.lock"), b"owned lock\n").unwrap();
        fs::write(
            value.repo.join(".git"),
            b"owned fixture, not a Git checkout",
        )
        .unwrap();
        value.approve("*");
        for tool in ["cargo", "rustc", "pkg-config"] {
            symlink(
                env!("CARGO_BIN_EXE_reverie-autoenv-shim"),
                value.shim.join(tool),
            )
            .unwrap();
            fs::hard_link(child(), value.plain.join(tool)).unwrap();
            fs::hard_link(child(), value.cached.join(tool)).unwrap();
        }
        for tool in ["helper", "nix"] {
            fs::hard_link(child(), value.plain.join(tool)).unwrap();
        }
        value
    }
    pub(crate) fn approve(&self, pattern: &str) {
        fs::write(
            &self.config,
            format!("{pattern} devShells.default cargo,rustc,pkg-config\n"),
        )
        .unwrap();
    }
    pub(crate) fn command(&self, program: impl AsRef<std::ffi::OsStr>) -> Command {
        let mut command = Command::new(program);
        command
            .env_clear()
            .current_dir(&self.repo)
            .env("HOME", &self.root)
            .env("REVERIE_AUTOENV_CONFIG", &self.config)
            .env("REVERIE_AUTOENV_CACHE", &self.cache)
            .env(
                "PATH",
                std::env::join_paths([&self.shim, &self.plain]).unwrap(),
            )
            .env("REVERIE_JOBS_HELPER", self.plain.join("helper"))
            .env("AUTOENV_TEST_MARKER", self.root.join("helper-called"))
            .env(
                "AUTOENV_TEST_JOBS_BINARY",
                env!("CARGO_BIN_EXE_reverie-build-jobs"),
            );
        command
    }
    pub(crate) fn builder(&self) -> Command {
        self.command(env!("CARGO_BIN_EXE_reverie-autoenv"))
    }
    pub(crate) fn key(&self) -> String {
        let output = self.builder().arg("key").arg(&self.repo).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end()
            .to_owned()
    }
    pub(crate) fn build(&self, raw: &[u8]) -> Output {
        let input = self.root.join("dev-env.json");
        fs::write(&input, raw).unwrap();
        self.builder()
            .arg("build")
            .arg(&self.repo)
            .arg("--from-json")
            .arg(input)
            .output()
            .unwrap()
    }
    pub(crate) fn values(output: &Output) -> BTreeMap<String, String> {
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        std::str::from_utf8(&output.stdout)
            .unwrap()
            .split_terminator('\0')
            .filter_map(|s| s.split_once('='))
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
