//! Inert owned programs for package-runner orchestration tests.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let root = PathBuf::from(std::env::var_os("XTASK_PACKAGE_FIXTURE_ROOT").unwrap());
    let args: Vec<_> = std::env::args().skip(1).collect();
    let mut trace = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("trace"))
        .unwrap();
    let failure = std::env::var("XTASK_PACKAGE_FAIL").unwrap_or_default();
    if args.first().is_some_and(|arg| arg == "build") {
        return build(&root, &args, &mut trace, &failure);
    }
    assert_eq!(
        args,
        [
            "-B",
            "-m",
            "unittest",
            "tests.test_worker_resource_launcher_package",
            "tests.test_owner_goal_broker.OwnerGoalBrokerTests.test_goal_stream_uses_only_closed_g_and_fresh_response",
            "tests.test_owner_goal_broker.OwnerGoalBrokerTests.test_goal_stream_mixed_arguments_and_bad_or_oversized_replies_fail_closed"
        ]
    );
    let executable = PathBuf::from(std::env::var_os("NIX_REVERIE_TEST_WORKER_EXEC").unwrap());
    let manifest =
        PathBuf::from(std::env::var_os("NIX_REVERIE_TEST_RESOURCE_CLIENT_MANIFEST").unwrap());
    assert_eq!(
        executable,
        fs::canonicalize(root.join("store-program/bin/reverie-worker-exec")).unwrap()
    );
    assert_eq!(
        manifest,
        fs::canonicalize(root.join("store-manifest/share/reverie/resource-client.json")).unwrap()
    );
    writeln!(
        trace,
        "python3\t{}\t{}",
        executable.display(),
        manifest.display()
    )
    .unwrap();
    if failure == "test" {
        ExitCode::from(23)
    } else {
        ExitCode::SUCCESS
    }
}

fn build(
    root: &std::path::Path,
    args: &[String],
    trace: &mut std::fs::File,
    failure: &str,
) -> ExitCode {
    use std::os::unix::fs::{PermissionsExt, symlink};
    assert_eq!(args.len(), 4);
    assert_eq!(args[2], "--out-link");
    let link = PathBuf::from(&args[3]);
    assert!(link.is_absolute());
    assert_eq!(
        fs::symlink_metadata(link.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    let (kind, leaf) = match args[1].as_str() {
        ".#workerExec" => ("program", "bin/reverie-worker-exec"),
        ".#workerResourceClientManifest" => ("manifest", "share/reverie/resource-client.json"),
        _ => panic!("unexpected package selection"),
    };
    writeln!(trace, "nix\t{}\t{}", args[1], link.display()).unwrap();
    if failure == kind {
        return ExitCode::from(17);
    }
    let store = root.join(format!("store-{kind}"));
    fs::create_dir_all(store.join(leaf).parent().unwrap()).unwrap();
    if failure != "resolve" || kind != "manifest" {
        fs::write(store.join(leaf), kind).unwrap();
    }
    symlink(&store, &link).unwrap();
    ExitCode::SUCCESS
}
