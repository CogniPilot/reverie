//! Genuine create/publish/start/memory/cold/pane/guard chain and owned PTY engine
//! subprocess. No Docker, company service, fabricated phase or raw PID permit.
use super::*;
mod admission;
mod group;
use crate::worker_storage::StorageLease;
use reverie_core::worker_launch::TerminalSize;
use std::sync::atomic::Ordering;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_laptop::tests::viewer::{name}"))
}
fn released(fixture: &Fixture) -> (LaptopWorkflow, CreatedLaptop, NixReleasedPane) {
    let (workflow, created, cold) = super::pane::cold(fixture);
    let PaneStart::Started(pane) = fixture.runtime().start_laptop_pane(&cold, end()).unwrap()
    else {
        panic!("actual pane")
    };
    let NixGuardRelease::Released(released) = fixture
        .runtime()
        .release_laptop_nix_guard(&pane, end())
        .unwrap()
    else {
        panic!("actual checked guard close")
    };
    (workflow, created, released)
}
fn start(fixture: &Fixture, released: &NixReleasedPane) -> ViewerSession {
    let ViewerStart::Started(viewer) = fixture
        .runtime()
        .start_laptop_viewer_session(released, end())
        .unwrap()
    else {
        panic!("actual session constructor")
    };
    wait(|| fixture.root.join("viewer-ready").is_file());
    viewer
}
fn wait(mut ready: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(3);
    while !ready() {
        assert!(Instant::now() < end, "owned fixture progress bound");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn read(fixture: &Fixture, viewer: &ViewerSession, bytes: &mut Vec<u8>, expected: &[u8]) {
    wait(|| {
        let mut buffer = [0; 65536];
        match fixture.runtime().read_laptop_viewer(viewer, &mut buffer) {
            Ok(n) => bytes.extend_from_slice(&buffer[..n]),
            Err(LaptopError::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            other => panic!("actual PTY read: {other:?}"),
        }
        bytes.ends_with(expected)
    });
}
#[test]
fn actual_session_pty_stdio_marker_resize_and_python_negative_signal_status() {
    if isolated("actual_session_pty_stdio_marker_resize_and_python_negative_signal_status") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let (workflow, created, released) = released(&fixture);
    let viewer = start(&fixture, &released);
    assert!(viewer.same_workflow(&workflow));
    assert!(
        fixture
            .runtime()
            .start_laptop_viewer_session(&released, end())
            .is_err()
    );
    assert_eq!(
        fixture
            .runtime()
            .write_laptop_viewer(&viewer, b"hello")
            .unwrap(),
        5
    );
    let mut bytes = Vec::new();
    read(&fixture, &viewer, &mut bytes, b"hello");
    fixture
        .runtime()
        .resize_laptop_viewer_pty(&viewer, TerminalSize::try_new(132, 43).unwrap())
        .unwrap();
    fixture
        .runtime()
        .write_laptop_viewer(&viewer, b"W")
        .unwrap();
    read(&fixture, &viewer, &mut bytes, b";");
    let count = std::str::from_utf8(&bytes[5..])
        .unwrap()
        .strip_prefix("WINCH=")
        .unwrap()
        .strip_suffix(';')
        .unwrap()
        .parse::<usize>()
        .unwrap();
    assert!(count >= 1);
    assert_eq!(
        fixture.runtime().laptop_viewer_status(&viewer).unwrap(),
        None
    );
    fixture
        .runtime()
        .close_laptop_viewer(&viewer, end())
        .unwrap();
    assert_eq!(
        fixture.runtime().laptop_viewer_status(&viewer).unwrap(),
        Some(-15)
    );
    fixture
        .runtime()
        .close_laptop_viewer(&viewer, end())
        .unwrap();
    assert!(
        fixture
            .runtime()
            .write_laptop_viewer(&viewer, b"later")
            .is_err()
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    ));
    assert!(
        fixture.runtime().close(end()).is_err(),
        "viewer close never releases created/storage owners"
    );
}
#[test]
fn observed_exit_keeps_last_pty_bytes_and_parent_slave_is_actually_closed() {
    if isolated("observed_exit_keeps_last_pty_bytes_and_parent_slave_is_actually_closed") {
        return;
    }
    let fixture = Fixture::new("created-viewer-exit");
    let (_, _, released) = released(&fixture);
    let viewer = start(&fixture, &released);
    wait(|| fixture.runtime().laptop_viewer_status(&viewer).unwrap() == Some(7));
    let mut bytes = Vec::new();
    read(&fixture, &viewer, &mut bytes, b"LAST");
    let mut buffer = [0; 1];
    let error = fixture
        .runtime()
        .read_laptop_viewer(&viewer, &mut buffer)
        .unwrap_err();
    assert!(
        matches!(error,LaptopError::Io(error) if error.raw_os_error()==Some(libc::EIO)),
        "no parent slave retained after successful spawn"
    );
    fixture
        .runtime()
        .close_laptop_viewer(&viewer, end())
        .unwrap();
}
#[test]
fn fixed_group_kill_follows_original_term_grace_and_never_targets_unrelated_child() {
    if isolated("fixed_group_kill_follows_original_term_grace_and_never_targets_unrelated_child") {
        return;
    }
    let fixture = Fixture::new("created-viewer-group");
    let (workflow, _, released) = released(&fixture);
    let viewer = start(&fixture, &released);
    let unrelated = Fixture::new("created-viewer-echo");
    let (_, _, other) = self::released(&unrelated);
    let other = start(&unrelated, &other);
    let before = Instant::now();
    let result = fixture
        .runtime()
        .close_laptop_viewer(&viewer, before + Duration::from_secs(8));
    assert!(before.elapsed() >= Duration::from_secs(5));
    assert_eq!(
        fixture.runtime().laptop_viewer_status(&viewer).unwrap(),
        Some(-9)
    );
    let descendant = fs::read_to_string(fixture.root.join("viewer-descendant")).unwrap();
    let path = PathBuf::from(format!("/proc/{descendant}/stat"));
    wait(|| {
        fs::read_to_string(&path).map_or(true, |stat| {
            stat.rsplit_once(") ").unwrap().1.starts_with("Z ")
        })
    });
    group::classify_group_close(&fixture, &workflow, result);
    assert_eq!(
        unrelated.runtime().laptop_viewer_status(&other).unwrap(),
        None
    );
    unrelated
        .runtime()
        .close_laptop_viewer(&other, end())
        .unwrap();
}
#[test]
fn terminal_cleanup_and_foreign_runtime_refuse_before_any_viewer_constructor() {
    if isolated("terminal_cleanup_and_foreign_runtime_refuse_before_any_viewer_constructor") {
        return;
    }
    let fixture = Fixture::new("created-viewer-echo");
    let (_, created, released) = released(&fixture);
    let other = Fixture::new("created-viewer-echo");
    assert!(
        other
            .runtime()
            .start_laptop_viewer_session(&released, end())
            .is_err()
    );
    assert!(!other.root.join("viewer-ready").exists());
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    ));
    assert!(
        fixture
            .runtime()
            .start_laptop_viewer_session(&released, end())
            .is_err()
    );
    assert!(!fixture.root.join("viewer-ready").exists());
}
#[test]
fn late_constructor_remains_in_same_record_and_stop_closes_the_actual_late_child() {
    if isolated("late_constructor_remains_in_same_record_and_stop_closes_the_actual_late_child") {
        return;
    }
    let fixture = Fixture::new("created-viewer-echo");
    let (workflow, _, released) = released(&fixture);
    let gate = Arc::new(crate::captured_client::test_hooks::Gate::default());
    struct Release(Arc<crate::captured_client::test_hooks::Gate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.released.store(true, Ordering::Release);
        }
    }
    let _release = Release(gate.clone());
    let runtime = fixture.runtime().clone();
    let pause = gate.clone();
    let task = std::thread::spawn(move || {
        super::super::viewer::test_hooks::next_constructor(pause);
        runtime.start_laptop_viewer_session(&released, Instant::now() + Duration::from_millis(200))
    });
    wait(|| gate.entered.load(Ordering::Acquire));
    assert!(matches!(
        task.join().unwrap().unwrap(),
        ViewerStart::Retained
    ));
    assert!(workflow.record.lock().unwrap().viewer.is_some());
    assert!(!fixture.root.join("viewer-ready").exists());
    fixture.runtime().request_stop();
    gate.released.store(true, Ordering::Release);
    // Pause was immediately before actual spawn: cancellation cannot abandon
    // that already selected constructor. Runtime inventories and reaps it.
    let job = workflow
        .record
        .lock()
        .unwrap()
        .viewer
        .as_ref()
        .unwrap()
        .clone();
    job.close(fixture.runtime(), end()).unwrap();
    assert_eq!(job.status().unwrap(), Some(-15));
    assert!(
        fixture.runtime().settle_owned(end()).is_err(),
        "created owner still prevents global ACK"
    );
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn foreign_reap_refuses_cleanup_without_dispatching_a_recycled_group_signal() {
    if isolated("foreign_reap_refuses_cleanup_without_dispatching_a_recycled_group_signal") {
        return;
    }
    let fixture = Fixture::new("created-viewer-exit");
    let (workflow, _, released) = released(&fixture);
    let viewer = start(&fixture, &released);
    wait(|| fixture.runtime().laptop_viewer_status(&viewer).unwrap() == Some(7));
    let job = workflow
        .record
        .lock()
        .unwrap()
        .viewer
        .as_ref()
        .unwrap()
        .clone();
    job.external_reap().unwrap();
    assert!(
        fixture
            .runtime()
            .close_laptop_viewer(&viewer, end())
            .is_err()
    );
    assert_eq!(job.native_counts(), (1, 0));
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn changed_sigchld_policy_retains_uncertainty_without_any_group_dispatch() {
    if isolated("changed_sigchld_policy_retains_uncertainty_without_any_group_dispatch") {
        return;
    }
    let fixture = Fixture::new("created-viewer-echo");
    let (workflow, _, released) = released(&fixture);
    let viewer = start(&fixture, &released);
    let policy = crate::native::viewer_session::test_policy::ignore().unwrap();
    assert!(
        fixture
            .runtime()
            .close_laptop_viewer(&viewer, end())
            .is_err()
    );
    let job = workflow
        .record
        .lock()
        .unwrap()
        .viewer
        .as_ref()
        .unwrap()
        .clone();
    assert_eq!(job.native_counts(), (1, 0));
    drop(policy);
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn unsupported_reaping_policy_refuses_constructor_before_the_fixed_attach_exec() {
    if isolated("unsupported_reaping_policy_refuses_constructor_before_the_fixed_attach_exec") {
        return;
    }
    let fixture = Fixture::new("created-viewer-echo");
    let (workflow, _, released) = released(&fixture);
    let policy = crate::native::viewer_session::test_policy::ignore().unwrap();
    assert!(matches!(
        fixture
            .runtime()
            .start_laptop_viewer_session(&released, end())
            .unwrap(),
        ViewerStart::Retained
    ));
    drop(policy);
    assert!(!fixture.root.join("viewer-ready").exists());
    assert!(
        !fs::read_to_string(fixture.root.join("trace"))
            .unwrap()
            .lines()
            .any(|line| line.starts_with("exec\0-it\0"))
    );
    assert!(workflow.failure().unwrap().is_some());
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn real_parent_descriptor_close_refusal_retains_child_and_never_retries_consumed_fd() {
    if isolated("real_parent_descriptor_close_refusal_retains_child_and_never_retries_consumed_fd")
    {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let (workflow, _, released) = released(&fixture);
    super::super::viewer::test_hooks::refuse_next_input_close();
    assert!(matches!(
        fixture
            .runtime()
            .start_laptop_viewer_session(&released, end())
            .unwrap(),
        ViewerStart::Retained
    ));
    let job = workflow
        .record
        .lock()
        .unwrap()
        .viewer
        .as_ref()
        .unwrap()
        .clone();
    assert!(job.close(fixture.runtime(), end()).is_err());
    assert_eq!(job.status().unwrap(), Some(-15));
    assert_eq!(job.native_counts(), (1, 1));
    assert!(job.close(fixture.runtime(), end()).is_err());
    assert_eq!(job.native_counts(), (1, 1));
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn actual_forward_io_holds_same_record_until_operation_completes_before_terminal_cleanup() {
    if isolated(
        "actual_forward_io_holds_same_record_until_operation_completes_before_terminal_cleanup",
    ) {
        return;
    }
    let fixture = Fixture::new("created-viewer-echo");
    let (_, created, released) = released(&fixture);
    let viewer = start(&fixture, &released);
    let gate = Arc::new(crate::captured_client::test_hooks::Gate::default());
    struct Release(Arc<crate::captured_client::test_hooks::Gate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.released.store(true, Ordering::Release);
        }
    }
    let _release = Release(gate.clone());
    let pause = gate.clone();
    let runtime = fixture.runtime().clone();
    let writer = std::thread::spawn(move || {
        super::super::viewer::test_hooks::next_write(pause);
        let result = runtime.write_laptop_viewer(&viewer, b"x");
        (viewer, result)
    });
    wait(|| gate.entered.load(Ordering::Acquire));
    assert!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .is_err()
    );
    assert!(!fixture.root.join("stopped-laptop").exists());
    gate.released.store(true, Ordering::Release);
    let (viewer, result) = writer.join().unwrap();
    assert_eq!(result.unwrap(), 1);
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    ));
    assert!(
        fixture
            .runtime()
            .write_laptop_viewer(&viewer, b"late")
            .is_err()
    );
    fixture
        .runtime()
        .close_laptop_viewer(&viewer, end())
        .unwrap();
}
#[test]
fn actual_spawn_error_never_becomes_a_no_child_cleanup_receipt() {
    if isolated("actual_spawn_error_never_becomes_a_no_child_cleanup_receipt") {
        return;
    }
    let fixture = Fixture::new("created-viewer-echo");
    let (workflow, _, released) = released(&fixture);
    let saved = fixture.root.join("saved-owned-engine");
    fs::rename(program(), &saved).unwrap();
    struct Restore(PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            fs::rename(&self.0, program()).unwrap();
        }
    }
    let _restore = Restore(saved);
    assert!(matches!(
        fixture
            .runtime()
            .start_laptop_viewer_session(&released, end())
            .unwrap(),
        ViewerStart::Retained
    ));
    let job = workflow
        .record
        .lock()
        .unwrap()
        .viewer
        .as_ref()
        .unwrap()
        .clone();
    assert!(
        matches!(workflow.failure().unwrap().as_deref(),Some(LaptopError::Io(error)) if error.kind()==std::io::ErrorKind::NotFound)
    );
    assert!(job.close(fixture.runtime(), end()).is_err());
    assert!(fixture.runtime().close(end()).is_err());
}
