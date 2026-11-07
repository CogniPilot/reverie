//! Genuine known-stop -> same actual Box/guard Nix -> immutable old rm. No
//! baseline/process/Created DTO, fake Nix outcome or host engine is accepted.
use super::*;
use crate::{
    worker_nix::{NixProgress, NixStoreGuard, NixWorkflow},
    worker_source_stop::StoppedLaptopRemoval,
};
use reverie_core::ids::ProfileSessionId;
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};
mod absent;
mod faults;
struct Cold {
    plan: ObservedCreatePlan,
    nix: NixWorkflow,
    removal: StoppedLaptopRemoval,
}
fn stopped(
    fixture: &Fixture,
    exact: bool,
) -> (Box<LaunchStorage>, ObservedCreatePlan, StoppedLaptopRemoval) {
    let (storage, plan, original) = inputs(fixture);
    if exact {
        let process = original
            .capture_running_replacement_process(&fixture.runtime, &plan, end())
            .unwrap();
        let mut owner = fixture
            .runtime
            .retain_ordinary_replacement_stop(storage, plan, process, None)
            .unwrap_or_else(|_| panic!("actual exact inputs"));
        owner.inspect(&fixture.runtime).unwrap();
        owner
            .stop_after_policy(
                &fixture.runtime,
                &worker_config::policy_digest(&fixture.config),
            )
            .unwrap();
        let (storage, plan, _original, removal) = owner
            .take_stopped(&fixture.runtime, end())
            .unwrap()
            .into_cold_parts();
        (storage, plan, removal)
    } else {
        let mut owner = fixture
            .runtime
            .retain_ordinary_laptop_stop_for_worker(storage, plan, original)
            .unwrap_or_else(|_| panic!("actual legacy inputs"));
        owner.stop_after_admission(&fixture.runtime).unwrap();
        let (storage, plan, _original, removal) = owner
            .take_stopped(&fixture.runtime, end())
            .unwrap()
            .into_cold_parts();
        (storage, plan, removal)
    }
}
fn nix(
    fixture: &Fixture,
    storage: Box<LaunchStorage>,
    plan: ObservedCreatePlan,
    removal: StoppedLaptopRemoval,
) -> Cold {
    let guard =
        NixStoreGuard::acquire_launch(&fixture.config, &ProfileSessionId::parse(SID).unwrap())
            .unwrap();
    let workflow = fixture
        .runtime
        .retain_nix_store(guard, *storage, fixture.config.clone())
        .unwrap_or_else(|_| panic!("same stopped resource"));
    assert_eq!(
        fixture.runtime.run_nix_store(&workflow).unwrap(),
        NixProgress::NoHelper
    );
    Cold {
        plan,
        nix: workflow,
        removal,
    }
}
fn prepare(fixture: &Fixture, exact: bool) -> Cold {
    let (storage, plan, removal) = stopped(fixture, exact);
    fs::write(
        fixture.root.join("container-census"),
        format!("{} test-agent-{SID}\n", fixture.row["Id"].as_str().unwrap()),
    )
    .unwrap();
    nix(fixture, storage, plan, removal)
}
fn reclaim(fixture: &Fixture, cold: Cold) {
    let returned = fixture
        .runtime
        .reclaim_nix_store(cold.nix)
        .unwrap_or_else(|_| panic!("same known Nix resource"));
    returned
        .assert_create_plan(&fixture.runtime, &cold.plan)
        .unwrap();
    let (guard, storage, result) = returned.into_parts();
    assert!(result.is_ok());
    fixture.assert_held();
    guard.close().unwrap();
    storage.close(end()).unwrap();
}
fn count(fixture: &Fixture, verb: &str) -> usize {
    fixture
        .trace()
        .iter()
        .filter(|line| line.split('\0').next() == Some(verb))
        .count()
}
#[test]
fn exact_and_legacy_stops_mint_real_post_nix_removal_once_for_same_resource() {
    if isolated(
        "worker_source_stop::tests::legacy::removal::exact_and_legacy_stops_mint_real_post_nix_removal_once_for_same_resource",
    ) {
        return;
    }
    for exact in [false, true] {
        let fixture = Fixture::new("stop-requested");
        let mut cold = prepare(&fixture, exact);
        assert!(!fixture.root.join("old-removed").exists());
        let proof = fixture
            .runtime
            .remove_stopped_laptop_after_nix_for_worker(&cold.nix, &cold.plan, &mut cold.removal)
            .unwrap();
        proof.assert_workflow(&fixture.runtime, &cold.nix).unwrap();
        assert!(fixture.root.join("old-removed").exists());
        assert_eq!(count(&fixture, "rm"), 1);
        fixture.assert_held();
        assert!(
            fixture
                .runtime
                .remove_stopped_laptop_after_nix_for_worker(
                    &cold.nix,
                    &cold.plan,
                    &mut cold.removal
                )
                .is_err()
        );
        assert_eq!(count(&fixture, "rm"), 1);
        let alias = cold.nix.clone();
        reclaim(&fixture, cold);
        assert!(proof.assert_workflow(&fixture.runtime, &alias).is_err());
    }
}
#[test]
fn original_target_already_absent_after_nix_needs_complete_census_and_no_rm() {
    if isolated(
        "worker_source_stop::tests::legacy::removal::original_target_already_absent_after_nix_needs_complete_census_and_no_rm",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let mut cold = prepare(&fixture, false);
    fs::write(
        fixture.root.join("old-removed"),
        b"actual target already reaped/removed",
    )
    .unwrap();
    fs::write(fixture.root.join("container-census"), b"").unwrap();
    let proof = fixture
        .runtime
        .remove_stopped_laptop_after_nix_for_worker(&cold.nix, &cold.plan, &mut cold.removal)
        .unwrap();
    proof.assert_workflow(&fixture.runtime, &cold.nix).unwrap();
    assert_eq!(count(&fixture, "rm"), 0);
    reclaim(&fixture, cold);
}
fn settle_retained(fixture: &mut Fixture, cold: &mut Cold) {
    fixture
        .runtime
        .installed_engine()
        .settle_owned(end())
        .unwrap();
    assert!(fixture.runtime.settle_owned(end()).is_err());
    assert!(
        fixture
            .runtime
            .remove_stopped_laptop_after_nix_for_worker(&cold.nix, &cold.plan, &mut cold.removal)
            .is_err()
    );
    assert!(fixture.runtime.reclaim_nix_store(cold.nix.clone()).is_err());
    fixture.assert_held();
    fixture.expect_retained_runtime();
}
struct Target {
    child: Child,
    root: PathBuf,
}
impl Target {
    fn new(fixture: &Fixture) -> Self {
        fs::remove_file(fixture.root.join("source-ready")).unwrap();
        let child = Command::new(fixture.fixed_target_program())
            .arg("target")
            .current_dir(&fixture.root)
            .env("SOURCE_EXIT_ON", "foreign-never")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let target = Self {
            child,
            root: fixture.root.clone(),
        };
        wait(|| fixture.root.join("source-ready").exists());
        target
    }
}
fn wait(mut ready: impl FnMut() -> bool) {
    let until = end();
    while !ready() {
        assert!(Instant::now() < until, "owned removal phase");
        std::thread::sleep(Duration::from_millis(1));
    }
}
impl Drop for Target {
    fn drop(&mut self) {
        fs::write(
            self.root.join("release-source"),
            b"owned foreign target teardown",
        )
        .unwrap();
        assert!(self.child.wait().unwrap().success());
    }
}
