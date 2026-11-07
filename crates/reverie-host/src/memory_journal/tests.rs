use super::*;
use crate::captured_client::test_hooks::Hooks;
use reverie_contracts::memory_cli::MemoryRequest;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::Command,
    sync::{OnceLock, atomic::AtomicUsize},
};
static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
static NEXT: AtomicUsize = AtomicUsize::new(0);
fn program() -> &'static Path {
    PROGRAM.get_or_init(|| {
        let path = std::env::temp_dir().join(format!("journal-child-build-{}", std::process::id()));
        fs::create_dir(&path).unwrap();
        let source = path.join("child.rs");
        fs::write(
            &source,
            include_str!("../../tests/support/memory_journal_child.rs"),
        )
        .unwrap();
        let program = path.join("compiled");
        assert!(
            Command::new("rustc")
                .arg("--edition=2024")
                .arg(source)
                .arg("-o")
                .arg(&program)
                .status()
                .unwrap()
                .success()
        );
        program
    })
}
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "journal-client-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root }
    }
    fn client(&self, mode: &str, hooks: Hooks) -> MemoryJournalClient {
        let path = self.root.join(mode);
        fs::hard_link(program(), &path).unwrap();
        let environment = vec![
            (
                OsString::from("REVERIE_SESSION_ID"),
                OsString::from("synthetic-session"),
            ),
            (OsString::from("RAW_PROBE"), OsString::from("first")),
            (OsString::from("RAW_PROBE"), OsString::from("second")),
            (
                OsString::from("OWNED_JOURNAL_TRACE"),
                self.root.join("trace").into_os_string(),
            ),
            (
                OsString::from("OWNED_JOURNAL_EFFECT"),
                self.root.join("effect").into_os_string(),
            ),
        ];
        let mut command =
            InstalledCommand::from_snapshot(path.as_os_str(), environment, self.root.clone(), true)
                .unwrap();
        command.hooks = hooks;
        MemoryJournalClient::from_command(command)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn request() -> JournalSaveRequest {
    let request=MemoryRequest::decode(reverie_core::PythonTextRef::from_scalar_text(r#"{"action":"remember","private":true,"text":"Synthetic verified handoff","room":"room-1","turn":"message-9","tag":"lesson","source":"commit:synthetic"}"#)).unwrap();
    let MemoryRequest::Remember { request } = request else {
        unreachable!()
    };
    request
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
#[test]
fn actual_public_client_argv_and_duplicate_environment_are_preserved_and_replies_stay_data() {
    let tree = Tree::new();
    let client = tree.client("success", Hooks::default());
    let request = request();
    let data = client
        .save(&request, deadline(), &CancellationToken::new())
        .unwrap();
    let data: serde_json::Value = serde_json::from_slice(data.as_json()).unwrap();
    assert_eq!(data["entryId"], "synthetic-id");
    assert_eq!(
        data["environment"],
        serde_json::json!(["6669727374", "7365636f6e64"])
    );
    let args = data["argv"].as_array().unwrap();
    assert_eq!(args[0], "6167656e74");
    assert_eq!(args[1], "6a6f75726e616c");
    assert_eq!(args[2], "73617665");
    assert_eq!(args.last().unwrap(), "2d2d6a736f6e");
    let entries = client
        .recall(
            &MetadataText::from_scalar_text(" query "),
            None,
            deadline(),
            &CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(entries.as_json()).unwrap(),
        serde_json::json!([{"entryId":"synthetic-id"}])
    );
    assert!(!client.has_unconfirmed_save());
    client.close(deadline()).unwrap();
}
#[test]
fn malformed_and_nonzero_save_results_never_confirm_or_automatically_retry() {
    for mode in ["nonzero", "empty", "badutf8"] {
        let tree = Tree::new();
        let client = tree.client(mode, Hooks::default());
        let error = client
            .save(&request(), deadline(), &CancellationToken::new())
            .err()
            .unwrap();
        assert!(error.save_is_unconfirmed());
        assert!(client.has_unconfirmed_save());
        assert!(tree.root.join("effect").is_file());
        assert_eq!(
            client
                .save(&request(), deadline(), &CancellationToken::new())
                .err()
                .unwrap()
                .fault(),
            JournalClientFault::UnknownSave
        );
        client.close(deadline()).unwrap();
        assert_eq!(
            fs::read_to_string(tree.root.join("trace")).unwrap(),
            "started\n"
        );
    }
}
#[test]
fn combined_pipe_bound_keeps_real_owned_cleanup() {
    let tree = Tree::new();
    let client = tree.client("dual", Hooks::default());
    let error = client
        .save(&request(), deadline(), &CancellationToken::new())
        .err()
        .unwrap();
    assert_eq!(error.fault(), JournalClientFault::OutputBound);
    assert!(error.save_is_unconfirmed());
    client.close(deadline()).unwrap();
}
#[test]
fn an_expired_call_refuses_before_any_real_constructor_or_effect() {
    let tree = Tree::new();
    let hooks = Hooks::default();
    let starts = std::sync::Arc::clone(&hooks.starts);
    let client = tree.client("hold", hooks);
    let error = client
        .save(
            &request(),
            Instant::now() - Duration::from_millis(60),
            &CancellationToken::new(),
        )
        .err()
        .unwrap();
    assert_eq!(error.fault(), JournalClientFault::Deadline);
    assert!(!error.save_is_unconfirmed());
    assert!(!client.has_unconfirmed_save());
    client.close(deadline()).unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert!(!tree.root.join("trace").exists());
    assert!(!tree.root.join("effect").exists());
}
#[test]
fn cancellation_after_a_real_child_effect_keeps_unknown_save_and_owned_cleanup() {
    use std::sync::Arc;
    let tree = Tree::new();
    let hooks = Hooks::default();
    let starts = Arc::clone(&hooks.starts);
    let client = Arc::new(tree.client("hold", hooks));
    let cancellation = CancellationToken::new();
    let other = Arc::clone(&client);
    let stop = cancellation.clone();
    let worker = std::thread::spawn(move || other.save(&request(), deadline(), &stop));
    // The immutable call deadline includes construction. It cannot establish
    // that a child started in 60ms under arbitrary scheduling. Observe this
    // fixture's actual child effect before testing post-effect cancellation.
    let effect = b"synthetic-effect-may-complete-before-reply";
    let limit = deadline();
    while !fs::read(tree.root.join("effect")).is_ok_and(|bytes| bytes == effect) {
        assert!(Instant::now() < limit);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(fs::read(tree.root.join("trace")).unwrap(), b"started\n");
    std::thread::sleep(Duration::from_millis(60));
    cancellation.cancel();
    let error = worker.join().unwrap().err().unwrap();
    assert_eq!(error.fault(), JournalClientFault::Cancelled);
    assert!(error.save_is_unconfirmed());
    client.close(deadline()).unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(fs::read(tree.root.join("effect")).unwrap(), effect);
    assert_eq!(
        client
            .save(&request(), deadline(), &CancellationToken::new())
            .err()
            .unwrap()
            .fault(),
        JournalClientFault::UnknownSave,
    );
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}
#[test]
fn actual_pipe_close_failure_remains_uncertain_and_fences_the_client() {
    use reverie_core::shutdown::ShutdownStatus;
    let tree = Tree::new();
    let hooks = Hooks::default();
    hooks.close_failed.store(true, Ordering::SeqCst);
    let client = tree.client("success", hooks);
    let error = client
        .save(&request(), deadline(), &CancellationToken::new())
        .err()
        .unwrap();
    assert!(error.process_is_unconfirmed());
    assert!(error.save_is_unconfirmed());
    assert!(client.close(deadline()).is_err());
    let ShutdownStatus::Refused(consumed) = client.shutdown(deadline()) else {
        panic!("all known native work was consumed, not successful cleanup")
    };
    assert!(consumed.process_is_unconfirmed());
    assert!(consumed.save_is_unconfirmed());
    assert!(client.has_unconfirmed_save());
    assert!(client.close(deadline()).is_err());
    assert_eq!(
        client
            .save(&request(), deadline(), &CancellationToken::new())
            .err()
            .unwrap()
            .fault(),
        JournalClientFault::UnknownSave
    );
    assert_eq!(
        fs::read_to_string(tree.root.join("trace")).unwrap(),
        "started\n"
    );
}
#[test]
fn a_late_constructor_is_pending_until_its_actual_process_is_adopted_and_reaped() {
    use crate::captured_client::test_hooks::Gate;
    use reverie_core::shutdown::ShutdownStatus;
    use std::sync::Arc;
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let hooks = Hooks {
        gate: Some(Arc::clone(&gate)),
        ..Hooks::default()
    };
    let starts = Arc::clone(&hooks.starts);
    let client = Arc::new(tree.client("success", hooks));
    let other = Arc::clone(&client);
    let worker = std::thread::spawn(move || {
        other.save(
            &request(),
            Instant::now() + Duration::from_millis(80),
            &CancellationToken::new(),
        )
    });
    let limit = deadline();
    while !gate.entered.load(Ordering::Acquire) {
        assert!(Instant::now() < limit);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(worker.join().unwrap().is_err());
    assert!(matches!(
        client.shutdown(Instant::now()),
        ShutdownStatus::Pending(_)
    ));
    gate.released.store(true, Ordering::Release);
    assert!(matches!(
        client.shutdown(deadline()),
        ShutdownStatus::Complete
    ));
    assert!(client.has_unconfirmed_save());
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        client
            .save(&request(), deadline(), &CancellationToken::new())
            .err()
            .unwrap()
            .fault(),
        JournalClientFault::UnknownSave
    );
}
#[test]
fn an_unchecked_actual_reap_remains_pending_after_the_capture_thread_finishes() {
    use reverie_core::shutdown::ShutdownStatus;
    let tree = Tree::new();
    let hooks = Hooks::default();
    hooks.reap_blocked.store(true, Ordering::SeqCst);
    let reap = std::sync::Arc::clone(&hooks.reap_blocked);
    let client = tree.client("success", hooks);
    assert!(
        client
            .save(
                &request(),
                Instant::now() + Duration::from_millis(80),
                &CancellationToken::new()
            )
            .is_err()
    );
    assert!(matches!(
        client.shutdown(Instant::now()),
        ShutdownStatus::Pending(_)
    ));
    reap.store(false, Ordering::SeqCst);
    assert!(matches!(
        client.shutdown(deadline()),
        ShutdownStatus::Complete
    ));
    assert!(client.has_unconfirmed_save());
}
