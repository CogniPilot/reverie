use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

pub(crate) struct TestDir(PathBuf);

impl TestDir {
    pub(crate) fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "reverie-xtask-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("create unique owned fixture directory");
        Self(path)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn write(&self, name: &str, contents: impl AsRef<[u8]>) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().expect("fixture parent")).expect("fixture parents");
        fs::write(&path, contents).expect("fixture source");
        path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove only this owned fixture tree");
    }
}

pub(crate) fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("xtask workspace root")
        .to_path_buf()
}

pub(crate) fn git(root: &Path, arguments: &[&str]) -> Output {
    Command::new("git")
        .args(arguments)
        .current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("run Git in owned fixture or selected workspace")
}

pub(crate) fn fixture_commit(root: &Path) -> String {
    assert!(git(root, &["init", "--quiet"]).status.success());
    assert!(git(root, &["add", "."]).status.success());
    assert!(
        git(
            root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "fixture base"
            ]
        )
        .status
        .success()
    );
    let output = git(root, &["rev-parse", "HEAD"]);
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .expect("fixture commit SHA")
        .trim()
        .to_owned()
}
