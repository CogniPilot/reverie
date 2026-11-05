#[cfg(target_os = "linux")]
mod linux {
    use crate::support::TestDir;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output};

    fn fixture(root: &TestDir) -> PathBuf {
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/worker_package_child.rs");
        let executable = root.path().join("package-child");
        let output = Command::new("rustc")
            .args(["--edition=2024"])
            .arg(source)
            .arg("-o")
            .arg(&executable)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let bin = root.path().join("bin");
        fs::create_dir(&bin).unwrap();
        for name in ["nix", "python3"] {
            symlink(&executable, bin.join(name)).unwrap();
        }
        let temporary = root.path().join("temporary with spaces");
        fs::create_dir(&temporary).unwrap();
        temporary
    }
    fn run(root: &TestDir, failure: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_xtask"))
            .arg("verify-worker-package")
            .env("PATH", root.path().join("bin"))
            .env("TMPDIR", root.path().join("temporary with spaces"))
            .env("XTASK_PACKAGE_FIXTURE_ROOT", root.path())
            .env("XTASK_PACKAGE_FAIL", failure)
            .env("NIX_REVERIE_TEST_WORKER_EXEC", "/ignored-ambient-program")
            .env(
                "NIX_REVERIE_TEST_RESOURCE_CLIENT_MANIFEST",
                "/ignored-ambient-manifest",
            )
            .output()
            .unwrap()
    }
    fn assert_only_outlinks_removed(root: &TestDir, temporary: &Path) {
        assert_eq!(fs::read_dir(temporary).unwrap().count(), 0);
        for (leaf, expected) in [
            (
                "store-program/bin/reverie-worker-exec",
                b"program".as_slice(),
            ),
            (
                "store-manifest/share/reverie/resource-client.json",
                b"manifest".as_slice(),
            ),
        ] {
            let path = root.path().join(leaf);
            if path.exists() {
                assert_eq!(fs::read(path).unwrap(), expected);
            }
        }
    }
    #[test]
    fn package_gate_selects_real_aliases_and_passes_fresh_canonical_paths() {
        let root = TestDir::new();
        let temporary = fixture(&root);
        let output = run(&root, "");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let trace = fs::read_to_string(root.path().join("trace")).unwrap();
        let rows: Vec<_> = trace.lines().collect();
        assert_eq!(rows.len(), 3);
        assert!(rows[0].starts_with("nix\t.#workerExec\t"));
        assert!(rows[1].starts_with("nix\t.#workerResourceClientManifest\t"));
        assert!(rows[2].starts_with("python3\t"));
        assert_only_outlinks_removed(&root, &temporary);
    }
    #[test]
    fn failed_build_path_resolution_or_qualification_stops_dependent_steps() {
        for (failure, count) in [("program", 1), ("manifest", 2), ("resolve", 2), ("test", 3)] {
            let root = TestDir::new();
            let temporary = fixture(&root);
            let output = run(&root, failure);
            assert!(!output.status.success(), "{failure}");
            assert_eq!(
                fs::read_to_string(root.path().join("trace"))
                    .unwrap()
                    .lines()
                    .count(),
                count,
                "{failure}"
            );
            assert_only_outlinks_removed(&root, &temporary);
        }
    }
}

#[cfg(not(target_os = "linux"))]
#[test]
fn native_package_gate_reports_unsupported_without_attempting_programs() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_xtask"))
        .arg("verify-worker-package")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("requires Linux"));
}
