use super::*;
mod installed;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
    process::Command,
    sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
static NEXT: AtomicUsize = AtomicUsize::new(0);
fn program() -> &'static Path {
    PROGRAM.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("nix-seed-build-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let source = root.join("child.rs");
        fs::write(
            &source,
            include_str!("../../../tests/support/nix_seed_child.rs"),
        )
        .unwrap();
        let binary = root.join("fixture");
        assert!(
            Command::new("rustc")
                .args(["--edition=2024", "-o"])
                .arg(&binary)
                .arg(&source)
                .status()
                .unwrap()
                .success()
        );
        binary
    })
}
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let _ = program();
        let root = std::env::temp_dir().join(format!(
            "nix-seed-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(root.join("tmp")).unwrap();
        fs::create_dir_all(root.join("target/nix")).unwrap();
        fs::hard_link(program(), root.join("nix-store")).unwrap();
        fs::hard_link(program(), root.join("nix")).unwrap();
        fs::write(root.join("registration"), b"registration\0binary\xff").unwrap();
        symlink("/nix/store/owned-fixture-image", root.join("base")).unwrap();
        Self { root }
    }
    fn bootstrap(&self, mode: &str) -> Bootstrap {
        Bootstrap {
            target: self.root.join("target/nix"),
            temporary: self.root.join("tmp"),
            registration: self.root.join("registration"),
            base: self.root.join("base"),
            nix_store: self.root.join("nix-store"),
            nix: self.root.join("nix"),
            directory: self.root.clone(),
            environment: BTreeMap::from([("SEED_MODE".into(), mode.into())]),
        }
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        // Only this private synthetic tree is disposable. Make its fake
        // database writable again for platforms/filesystems that require it.
        let database = self.root.join("tmp/nix-bootstrap-state/db/db.sqlite");
        if database.exists() {
            fs::set_permissions(database, fs::Permissions::from_mode(0o600)).unwrap();
        }
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(15)
}

#[test]
fn actual_fixed_guest_pipeline_streams_registration_preserves_prior_bytes_and_bounds_progress() {
    let tree = Tree::new();
    let input = (0..6_000_001).map(|n| (n % 256) as u8).collect::<Vec<_>>();
    fs::write(tree.root.join("registration"), &input).unwrap();
    let roots = tree.root.join("target/nix/var/nix/gcroots");
    fs::create_dir_all(&roots).unwrap();
    fs::write(roots.join("reverie-image"), b"previous-owned-registration").unwrap();
    fs::hard_link(roots.join("reverie-image"), roots.join("previous-hardlink")).unwrap();
    let mut seed = GuestNixSeed::new(tree.bootstrap("success"));
    seed.seed(deadline()).unwrap();
    assert_eq!(
        fs::read(tree.root.join("tmp/actual-registration")).unwrap(),
        input
    );
    assert_eq!(
        fs::read(tree.root.join("tmp/load-args")).unwrap(),
        b"--load-db"
    );
    assert_eq!(
        fs::read_link(roots.join("reverie-image")).unwrap(),
        Path::new("/nix/store/owned-fixture-image")
    );
    assert_eq!(
        fs::read(roots.join("previous-hardlink")).unwrap(),
        b"previous-owned-registration"
    );
    assert!(seed.registration.is_none());
    let (stdout, stderr) = seed.output();
    assert!(!stdout.is_empty() && !stderr.is_empty());
    assert!(stdout.len() <= 65_539 && stderr.len() <= 65_539);
    assert!(std::str::from_utf8(stdout).is_ok());
    assert!(matches!(
        seed.seed(deadline()),
        Err(SeedError::AlreadyAttempted)
    ));
    seed.finish(deadline()).unwrap();
    seed.finish(deadline()).unwrap();
}

#[test]
fn fixed_guest_child_failure_keeps_actual_status_and_raw_diagnostics_without_later_phases() {
    for (mode, status, copied) in [("import-failed", 7, false), ("copy-failed", 9, true)] {
        let tree = Tree::new();
        let mut seed = GuestNixSeed::new(tree.bootstrap(mode));
        let error = seed.seed(deadline()).unwrap_err();
        assert_eq!(error.exit_code(), status);
        assert_eq!(tree.root.join("tmp/copy-args").exists(), copied);
        assert!(
            !tree
                .root
                .join("target/nix/var/nix/gcroots/reverie-image")
                .exists()
        );
        if !copied {
            assert_eq!(seed.output().0, &[255]);
        }
        seed.finish(deadline()).unwrap();
    }
}

#[test]
fn fixed_guest_missing_registration_or_program_is_one_shot_and_keeps_existing_target_data() {
    for missing in ["registration", "nix-store"] {
        let tree = Tree::new();
        fs::write(tree.root.join("target/nix/prior"), b"retained").unwrap();
        fs::remove_file(tree.root.join(missing)).unwrap();
        let mut seed = GuestNixSeed::new(tree.bootstrap("success"));
        assert!(seed.seed(deadline()).is_err());
        assert!(matches!(
            seed.seed(deadline()),
            Err(SeedError::AlreadyAttempted)
        ));
        seed.finish(deadline()).unwrap();
        assert!(seed.registration.is_none());
        assert_eq!(
            fs::read(tree.root.join("target/nix/prior")).unwrap(),
            b"retained"
        );
    }
}

#[test]
fn installed_guest_capture_cannot_be_replaced_after_checked_finish() {
    if crate::test_process::isolate_case(
        "worker_nix::guest::tests::installed_guest_capture_cannot_be_replaced_after_checked_finish",
    ) {
        return;
    }
    let mut owner = GuestNixSeed::installed().unwrap();
    // Do not execute the installed fixed paths in a host test. Constructor and
    // checked signal restoration alone establish the one-shot lifecycle rule.
    owner.finish(deadline()).unwrap();
    assert!(matches!(
        GuestNixSeed::installed(),
        Err(SeedError::AlreadyAttempted)
    ));
}

fn client(tree: &Tree, mode: &str, hooks: captured_client::test_hooks::Hooks) -> CapturedClient {
    let bootstrap = tree.bootstrap(mode);
    let mut command = InstalledCommand::from_service(
        bootstrap.nix_store.as_os_str(),
        bootstrap.environment(),
        bootstrap.directory,
    )
    .unwrap();
    command.hooks = hooks;
    CapturedClient::new(command)
}

#[test]
fn registration_stays_with_caller_before_admission_and_null_stdin_remains_default() {
    let tree = Tree::new();
    let client = client(
        &tree,
        "success",
        captured_client::test_hooks::Hooks::default(),
    );
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let mut registration = Some(File::open(tree.root.join("registration")).unwrap());
    let error = client
        .run_nix_bootstrap(
            vec!["--load-db".into()],
            deadline(),
            &cancellation,
            &mut registration,
        )
        .err()
        .unwrap();
    assert_eq!(error.fault, captured_client::Fault::Cancelled);
    assert!(registration.is_some());
    assert!(!tree.root.join("tmp/actual-registration").exists());
    native::owned_process::close(registration.take().unwrap().into()).unwrap();
    let output = client
        .run(
            vec!["--load-db".into()],
            deadline(),
            &CancellationToken::new(),
            captured_client::Policy {
                maximum: Duration::from_secs(2),
                maximum_output: 1024,
                successful_exit: true,
            },
        )
        .unwrap();
    assert!(output.succeeded);
    assert_eq!(
        fs::read(tree.root.join("tmp/actual-registration")).unwrap(),
        b""
    );
    client.close(deadline()).unwrap();
}

#[test]
fn delayed_constructor_retains_registration_and_pending_shutdown_then_settles_exactly_once() {
    use crate::captured_client::test_hooks::{Gate, Hooks};
    use reverie_core::shutdown::ShutdownStatus;
    use std::sync::Arc;
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        gate: Some(gate.clone()),
        ..Hooks::default()
    };
    let starts = hooks.starts.clone();
    let client = Arc::new(client(&tree, "success", hooks));
    let input = File::open(tree.root.join("registration")).unwrap();
    let identity = input.metadata().unwrap();
    let worker = client.clone();
    let task = std::thread::spawn(move || {
        let mut input = Some(input);
        let result = worker.run_nix_bootstrap(
            vec!["--load-db".into()],
            Instant::now() + Duration::from_millis(80),
            &CancellationToken::new(),
            &mut input,
        );
        assert!(input.is_none());
        result
    });
    let end = deadline();
    while !gate.entered.load(Ordering::Acquire) {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(task.join().unwrap().err().unwrap().is_uncertain());
    assert_eq!(
        registration_references(&identity),
        1,
        "constructor still owns the exact registration inode"
    );
    assert!(matches!(
        client.shutdown(Instant::now()),
        ShutdownStatus::Pending(_)
    ));
    gate.released.store(true, Ordering::Release);
    assert!(matches!(
        client.shutdown(deadline()),
        ShutdownStatus::Complete
    ));
    assert_eq!(starts.load(Ordering::Acquire), 1);
    assert_eq!(registration_references(&identity), 0);
}

fn registration_references(identity: &fs::Metadata) -> usize {
    use std::os::unix::fs::MetadataExt;
    fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| fs::metadata(entry.ok()?.path()).ok())
        .filter(|current| current.dev() == identity.dev() && current.ino() == identity.ino())
        .count()
}

#[test]
fn registration_close_failure_after_actual_close_never_reports_success_or_retries() {
    use crate::captured_client::test_hooks::Hooks;
    use reverie_core::shutdown::ShutdownStatus;
    let tree = Tree::new();
    let hooks = Hooks::default();
    hooks
        .registration_close_failed
        .store(true, Ordering::Release);
    let starts = hooks.starts.clone();
    let client = client(&tree, "success", hooks);
    let mut input = Some(File::open(tree.root.join("registration")).unwrap());
    let error = client
        .run_nix_bootstrap(
            vec!["--load-db".into()],
            deadline(),
            &CancellationToken::new(),
            &mut input,
        )
        .err()
        .unwrap();
    assert!(input.is_none());
    assert!(error.is_uncertain());
    assert!(
        error
            .cleanup
            .contains(&captured_client::CleanupFault::RegistrationClose)
    );
    assert!(matches!(
        client.shutdown(deadline()),
        ShutdownStatus::Refused(_)
    ));
    assert_eq!(starts.load(Ordering::Acquire), 1);
}

#[test]
fn failed_exec_retains_registration_close_fault_with_no_started_child() {
    use crate::captured_client::test_hooks::Hooks;
    let tree = Tree::new();
    let hooks = Hooks::default();
    hooks
        .registration_close_failed
        .store(true, Ordering::Release);
    let client = client(&tree, "success", hooks);
    fs::remove_file(tree.root.join("nix-store")).unwrap();
    let mut input = Some(File::open(tree.root.join("registration")).unwrap());
    let error = client
        .run_nix_bootstrap(
            vec!["--load-db".into()],
            deadline(),
            &CancellationToken::new(),
            &mut input,
        )
        .err()
        .unwrap();
    assert!(!error.may_have_started);
    assert!(error.is_uncertain());
    assert_eq!(error.fault, captured_client::Fault::Spawn);
    assert!(
        error
            .cleanup
            .contains(&captured_client::CleanupFault::RegistrationClose)
    );
    assert!(client.close(deadline()).is_err());
}

#[test]
fn registration_opened_as_stdin_is_reserved_before_child_stdio_setup() {
    use std::os::fd::AsRawFd;
    if crate::test_process::isolate_case(
        "worker_nix::guest::tests::registration_opened_as_stdin_is_reserved_before_child_stdio_setup",
    ) {
        return;
    }
    let tree = Tree::new();
    let client = client(
        &tree,
        "success",
        captured_client::test_hooks::Hooks::default(),
    );
    nix::unistd::close(0).unwrap();
    let file = File::open(tree.root.join("registration")).unwrap();
    assert_eq!(file.as_raw_fd(), 0);
    let mut input = Some(file);
    let output = client
        .run_nix_bootstrap(
            vec!["--load-db".into()],
            deadline(),
            &CancellationToken::new(),
            &mut input,
        )
        .ok()
        .unwrap();
    assert!(output.succeeded);
    assert!(input.is_none());
    assert_eq!(
        fs::read(tree.root.join("tmp/actual-registration")).unwrap(),
        b"registration\0binary\xff"
    );
    client.close(deadline()).unwrap();
}

#[test]
fn running_guest_cancellation_consumes_owned_input_and_reaps_only_its_child() {
    use std::sync::Arc;
    let tree = Tree::new();
    let hooks = captured_client::test_hooks::Hooks::default();
    let starts = hooks.starts.clone();
    let client = Arc::new(client(&tree, "stall", hooks));
    let token = CancellationToken::new();
    let external = token.clone();
    let owned = client.clone();
    let input = File::open(tree.root.join("registration")).unwrap();
    let task = std::thread::spawn(move || {
        let mut input = Some(input);
        let result =
            owned.run_nix_bootstrap(vec!["--load-db".into()], deadline(), &external, &mut input);
        assert!(input.is_none());
        result
    });
    let end = deadline();
    while starts.load(Ordering::Acquire) == 0 {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(1));
    }
    token.cancel();
    let error = task.join().unwrap().err().unwrap();
    assert_eq!(error.fault, captured_client::Fault::Cancelled);
    client.close(deadline()).unwrap();
    assert!(!tree.root.join("tmp/actual-registration").exists());
    assert_eq!(starts.load(Ordering::Acquire), 1);
}

#[test]
fn actual_original_bash_seed_recipes_match_status_retained_tree_and_progress_suffixes() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/legacy-seed.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let tree = Tree::new();
        fs::remove_file(tree.root.join("base")).unwrap();
        symlink(case["base"].as_str().unwrap(), tree.root.join("base")).unwrap();
        if case["missing_registration"].as_bool().unwrap() {
            fs::remove_file(tree.root.join("registration")).unwrap();
        }
        prepare_prior(&tree, case["prior"].as_str().unwrap());
        let mut seed = GuestNixSeed::new(tree.bootstrap(case["mode"].as_str().unwrap()));
        let result = seed.seed(deadline());
        let status = result.err().map_or(0, |error| error.exit_code());
        seed.finish(deadline()).unwrap();
        assert_eq!(
            u64::from(status),
            case["status"].as_u64().unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(snapshot(&tree), case["snapshot"], "{}", case["name"]);
        assert_output(seed.output().0, &case["stdout"]);
        // Shell redirection errors have different CLI wording; compare actual
        // child progress only. Status and every retained filesystem byte still
        // match for the pre-child missing-registration refusal.
        if !case["missing_registration"].as_bool().unwrap() {
            assert_output(seed.output().1, &case["stderr"]);
        }
    }
}

fn prepare_prior(tree: &Tree, kind: &str) {
    if kind == "none" {
        return;
    }
    let path = tree.root.join("target/nix/var/nix/gcroots/reverie-image");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    match kind {
        "regular" => {
            fs::write(&path, b"previous-owned-registration").unwrap();
            fs::hard_link(&path, path.with_file_name("previous-hardlink")).unwrap();
        }
        "symlink" => symlink("/prior/image", path).unwrap(),
        "directory" => fs::create_dir(path).unwrap(),
        _ => panic!("unknown fixture"),
    }
}
fn assert_output(actual: &[u8], expected: &serde_json::Value) {
    if let Some(raw) = expected["raw_hex"].as_str() {
        assert_eq!(hex(actual), raw);
    } else {
        assert!(
            std::str::from_utf8(actual)
                .unwrap()
                .ends_with(expected["text_tail"].as_str().unwrap())
        );
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn replace_root(bytes: &[u8], root: &[u8]) -> Vec<u8> {
    let mut suffix = bytes;
    let mut result = Vec::new();
    while let Some(index) = suffix.windows(root.len()).position(|part| part == root) {
        result.extend_from_slice(&suffix[..index]);
        result.extend_from_slice(b"$ROOT");
        suffix = &suffix[index + root.len()..];
    }
    result.extend_from_slice(suffix);
    result
}
fn snapshot(tree: &Tree) -> serde_json::Value {
    let mut entries = Vec::new();
    snapshot_directory(&tree.root, &tree.root, &mut entries);
    entries.sort_by_key(|entry| entry["path"].as_str().unwrap().to_owned());
    serde_json::Value::Array(entries)
}
fn snapshot_directory(root: &Path, parent: &Path, entries: &mut Vec<serde_json::Value>) {
    use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
    for entry in fs::read_dir(parent).unwrap() {
        let path = entry.unwrap().path();
        let relative = path.strip_prefix(root).unwrap().to_str().unwrap();
        if matches!(relative, "nix" | "nix-store" | "registration" | "base") {
            continue;
        }
        let info = fs::symlink_metadata(&path).unwrap();
        let kind = if info.is_dir() {
            "directory"
        } else if info.file_type().is_symlink() {
            "link"
        } else {
            "file"
        };
        let mut item = serde_json::json!({"path":relative,"mode":info.mode() & 0o7777,"kind":kind});
        if kind == "link" {
            item["target"] = fs::read_link(&path)
                .unwrap()
                .to_str()
                .unwrap()
                .replace(root.to_str().unwrap(), "$ROOT")
                .into();
        }
        if kind == "file" {
            item["bytes"] = hex(&replace_root(
                &fs::read(&path).unwrap(),
                root.as_os_str().as_bytes(),
            ))
            .into();
            item["links"] = info.nlink().into();
        }
        entries.push(item);
        if kind == "directory" {
            snapshot_directory(root, &path, entries);
        }
    }
}
