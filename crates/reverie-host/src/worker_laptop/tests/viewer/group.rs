//! Exact early-exit leader/live member counterpart. Numeric IDs are readonly
//! observations; fixture cleanup is a fixed self-exit file, never kill(PID).
use super::*;
fn running(path: &Path) -> bool {
    fs::read_to_string(path).is_ok_and(|stat| !stat.rsplit_once(") ").unwrap().1.starts_with("Z "))
}
struct ReleaseMember {
    root: PathBuf,
    stat: PathBuf,
}
impl Drop for ReleaseMember {
    fn drop(&mut self) {
        let _ = fs::write(
            self.root.join("release-viewer-descendant"),
            b"owned fixture self-exit",
        );
        let end = Instant::now() + Duration::from_secs(3);
        while running(&self.stat) && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
#[test]
fn already_exited_leader_keeps_pin_until_its_actual_live_group_member_is_settled() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::viewer::group::already_exited_leader_keeps_pin_until_its_actual_live_group_member_is_settled",
    ) {
        return;
    }
    let fixture = Fixture::new("created-viewer-early-group");
    let (workflow, _, released) = released(&fixture);
    let viewer = start(&fixture, &released);
    eprintln!("owned fixture executable: {}", program().display());
    wait(|| fixture.runtime().laptop_viewer_status(&viewer).unwrap() == Some(7));
    let member = fs::read_to_string(fixture.root.join("viewer-descendant")).unwrap();
    let stat = PathBuf::from(format!("/proc/{member}/stat"));
    let _release = ReleaseMember {
        root: fixture.root.clone(),
        stat: stat.clone(),
    };
    let identity = fs::read_to_string(fixture.root.join("viewer-identity")).unwrap();
    let leader = identity.split_whitespace().next().unwrap();
    let row = fs::read_to_string(&stat).unwrap();
    assert_eq!(
        row.rsplit_once(") ")
            .unwrap()
            .1
            .split_whitespace()
            .nth(2)
            .unwrap(),
        leader
    );
    assert!(running(&stat));
    let result = fixture.runtime().close_laptop_viewer(&viewer, end());
    assert!(
        !running(&stat),
        "local leader exit/FD close left actual owned group member {member} running"
    );
    classify_group_close(&fixture, &workflow, result);
    assert!(
        fixture.runtime().close(end()).is_err(),
        "container/storage ownership is independent"
    );
}
pub(in crate::worker_laptop::tests) fn classify_group_close(
    fixture: &Fixture,
    workflow: &LaptopWorkflow,
    result: Result<()>,
) {
    let job = workflow
        .record
        .lock()
        .unwrap()
        .viewer
        .as_ref()
        .unwrap()
        .clone();
    assert_eq!(
        job.native_counts(),
        (1, 1),
        "one final destructive decision while the leader pin was retained"
    );
    assert!(job.test_identity_consumed());
    match result {
        Ok(()) => assert!(!job.test_group_pending()),
        Err(error) => {
            assert_eq!(error.code(), "VIEWER_UNREAPED");
            assert!(
                job.test_group_pending(),
                "existing/zombie group remains unconfirmed, never positive closure"
            );
            assert!(job.close(fixture.runtime(), end()).is_err());
        }
    }
    let before = job.native_counts();
    assert!(job.test_post_reap_group_signal().is_err());
    assert_eq!(
        job.native_counts(),
        before,
        "no destructive signal after reap"
    );
}
#[test]
fn errored_final_group_signal_is_sticky_pinned_and_never_becomes_sent_completion() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::viewer::group::errored_final_group_signal_is_sticky_pinned_and_never_becomes_sent_completion",
    ) {
        return;
    }
    let fixture = Fixture::new("created-viewer-echo");
    let (workflow, _, released) = released(&fixture);
    super::super::super::viewer::test_hooks::refuse_next_input_close();
    super::super::super::viewer::test_hooks::refuse_next_group_result();
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
    let client = fixture.runtime().installed_engine().engine.client.clone();
    assert!(matches!(
        client.shutdown(end()),
        reverie_core::shutdown::ShutdownStatus::Pending(_)
    ));
    assert_eq!(job.native_counts(), (1, 1));
    assert!(!job.test_identity_consumed());
    assert!(matches!(
        job.failure().unwrap().as_deref(),
        Some(LaptopError::Finalization { .. })
    ));
    assert!(job.close(fixture.runtime(), end()).is_err());
    assert_eq!(job.native_counts(), (1, 1));
    assert!(!job.test_identity_consumed());
    assert_eq!(job.test_probe_count(), 0);
    wait(|| job.status().unwrap().is_some());
    job.test_reap_exited().unwrap();
    assert!(job.test_post_reap_group_signal().is_err());
    assert_eq!(job.native_counts(), (1, 1));
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn refused_actual_absence_observation_counts_pending_and_never_gets_a_fresh_probe_budget() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::viewer::group::refused_actual_absence_observation_counts_pending_and_never_gets_a_fresh_probe_budget",
    ) {
        return;
    }
    let fixture = Fixture::new("created-viewer-echo");
    let (workflow, _, released) = released(&fixture);
    super::super::super::viewer::test_hooks::refuse_next_input_close();
    super::super::super::viewer::test_hooks::refuse_next_probe_result();
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
    let client = fixture.runtime().installed_engine().engine.client.clone();
    assert!(matches!(
        client.shutdown(end()),
        reverie_core::shutdown::ShutdownStatus::Pending(_)
    ));
    assert!(job.test_identity_consumed());
    assert!(job.test_group_pending());
    assert_eq!(job.native_counts(), (1, 1));
    let count = job.test_probe_count();
    assert!(count >= 1);
    wait(|| Instant::now() >= job.test_kill_end());
    assert!(job.close(fixture.runtime(), end()).is_err());
    assert_eq!(job.test_probe_count(), count);
    assert_eq!(job.native_counts(), (1, 1));
    assert!(job.test_post_reap_group_signal().is_err());
    assert!(fixture.runtime().close(end()).is_err());
}
