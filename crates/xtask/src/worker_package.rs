//! Build/test orchestration only. Existing package tests own artifact validation.
#[cfg(target_os = "linux")]
mod linux {
    use crate::run_command;
    use std::error::Error;
    use std::fs;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    type Result<T> = std::result::Result<T, Box<dyn Error>>;
    const PROGRAM: &str = "worker-exec";
    const MANIFEST: &str = "resource-manifest";
    const CHILD: &str = "worker-child";
    const NATIVE_CHILD: &str = "native-worker-child";
    struct Scratch {
        path: PathBuf,
        identity: (u64, u64),
        anchor: Option<fs::File>,
        armed: bool,
    }
    impl Scratch {
        fn new() -> Result<Self> {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
            let path = std::env::temp_dir().join(format!(
                "reverie-worker-package-{}-{nonce}",
                std::process::id()
            ));
            fs::DirBuilder::new().mode(0o700).create(&path)?;
            let meta = fs::symlink_metadata(&path)?;
            let mut scratch = Self {
                path,
                identity: (meta.dev(), meta.ino()),
                anchor: None,
                armed: true,
            };
            fs::set_permissions(&scratch.path, fs::Permissions::from_mode(0o700))?;
            let anchor = fs::File::open(&scratch.path)?;
            let pinned = anchor.metadata()?;
            if !pinned.is_dir() || (pinned.dev(), pinned.ino()) != scratch.identity {
                return Err("package scratch directory changed before pinning".into());
            }
            scratch.anchor = Some(anchor);
            scratch.path = fs::canonicalize(&scratch.path)?;
            Ok(scratch)
        }
        fn cleanup(&self) -> Result<()> {
            if self.anchor.is_none() {
                return Err("unbound package scratch directory retained".into());
            }
            let meta = fs::symlink_metadata(&self.path)?;
            if !meta.is_dir() || (meta.dev(), meta.ino()) != self.identity {
                return Err("package scratch directory changed; retained".into());
            }
            for name in [PROGRAM, MANIFEST, CHILD, NATIVE_CHILD] {
                self.unlink(name)?;
            }
            fs::remove_dir(&self.path)?;
            Ok(())
        }
        fn unlink(&self, name: &str) -> Result<()> {
            let path = self.path.join(name);
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => fs::remove_file(path)?,
                Ok(_) => return Err("unexpected non-symlink package output retained".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            Ok(())
        }
        fn finish(mut self, result: Result<()>) -> Result<()> {
            let cleanup = self.cleanup();
            self.armed = false;
            match (result, cleanup) {
                (Ok(()), Ok(())) => Ok(()),
                (Err(error), Ok(())) => Err(error),
                (result, Err(cleanup)) => Err(format!(
                    "package gate result {result:?}; cleanup failed: {cleanup}; retained {}",
                    self.path.display()
                )
                .into()),
            }
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            if self.armed
                && let Err(error) = self.cleanup()
            {
                eprintln!("xtask: {error}; retained {}", self.path.display());
            }
        }
    }
    fn qualify(root: &Path, scratch: &Scratch) -> Result<()> {
        for (attribute, name) in [
            (".#workerExec", PROGRAM),
            (".#workerResourceClientManifest", MANIFEST),
        ] {
            build(root, scratch, attribute, name)?;
        }
        let executable =
            fs::canonicalize(scratch.path.join(PROGRAM).join("bin/reverie-worker-exec"))?;
        let manifest = fs::canonicalize(
            scratch
                .path
                .join(MANIFEST)
                .join("share/reverie/resource-client.json"),
        )?;
        run_command(
            Command::new("python3")
                .args([
                    "-B",
                    "-m",
                    "unittest",
                    "tests.test_worker_resource_launcher_package",
                    "tests.test_owner_goal_broker.OwnerGoalBrokerTests.test_goal_stream_uses_only_closed_g_and_fresh_response",
                    "tests.test_owner_goal_broker.OwnerGoalBrokerTests.test_goal_stream_mixed_arguments_and_bad_or_oversized_replies_fail_closed",
                ])
                .env("NIX_REVERIE_TEST_WORKER_EXEC", executable)
                .env("NIX_REVERIE_TEST_RESOURCE_CLIENT_MANIFEST", manifest)
                .current_dir(root),
        )
    }
    fn build(root: &Path, scratch: &Scratch, attribute: &str, name: &str) -> Result<()> {
        run_command(
            Command::new("nix")
                .args(["build", attribute, "--out-link"])
                .arg(scratch.path.join(name))
                .current_dir(root),
        )
    }
    pub(super) fn verify_child(root: &Path) -> Result<()> {
        let scratch = Scratch::new()?;
        let result = (|| {
            for (attribute, name) in [
                (".#workerChild", CHILD),
                (".#workerNativeChild", NATIVE_CHILD),
            ] {
                build(root, &scratch, attribute, name)?;
            }
            run_command(
                Command::new("cargo")
                    .args([
                        "test",
                        "--locked",
                        "-p",
                        "reverie-worker-child",
                        "--test",
                        "package",
                        "--",
                        "--ignored",
                        "--exact",
                        "selected_public_runtime_child_is_native_and_supports_pane_exit",
                        "--nocapture",
                        "--test-threads=1",
                    ])
                    .env(
                        "NIX_REVERIE_TEST_SELECTED_WORKER_CHILD",
                        fs::canonicalize(
                            scratch.path.join(CHILD).join("bin/reverie-worker-child"),
                        )?,
                    )
                    .env(
                        "NIX_REVERIE_TEST_NATIVE_WORKER_CHILD",
                        fs::canonicalize(
                            scratch
                                .path
                                .join(NATIVE_CHILD)
                                .join("bin/reverie-worker-child"),
                        )?,
                    )
                    .current_dir(root),
            )
        })();
        scratch.finish(result)
    }
    pub(super) fn verify(root: &Path) -> Result<()> {
        let scratch = Scratch::new()?;
        let result = qualify(root, &scratch);
        scratch.finish(result)
    }
}

pub(crate) fn verify_child(root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    {
        linux::verify_child(root)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _root = root;
        Err("verify-worker-child-package requires Linux; no package checks ran".into())
    }
}

pub(crate) fn verify(root: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    {
        linux::verify(root)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _root = root;
        Err("verify-worker-package requires Linux; no package checks ran".into())
    }
}
