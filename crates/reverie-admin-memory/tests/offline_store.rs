//! Exercise the installed aliases and exact Docker argv with real private files.
#[path = "support/offline_store/mod.rs"]
mod support;

use serde_json::{Value, json};
use std::{
    fs::{self, File},
    os::unix::fs::symlink,
};
use support::{Fixture, Sandbox, digest, error, expiry, success};

struct Harness {
    _root: Sandbox,
    docker: std::path::PathBuf,
}

impl Harness {
    fn new() -> Option<Self> {
        if nix::unistd::getuid().is_root() {
            return None;
        }
        let root = Sandbox::new();
        let docker = root.docker();
        Some(Self {
            _root: root,
            docker,
        })
    }

    fn fixture(&self) -> Fixture {
        Fixture::new(&self.docker)
    }
}

#[test]
fn plan_and_apply_use_exact_native_effects_and_preserve_existing_data() {
    let Some(harness) = Harness::new() else {
        return;
    };
    let fixture = harness.fixture();
    let before = fs::read(fixture.path("company.json")).unwrap();
    let config = fs::read(fixture.path("broker.json")).unwrap();
    let stopped = fs::read(fixture.path("stopped.json")).unwrap();
    let plan = fixture.plan();
    assert!(fixture.calls().is_empty());
    assert!(!fixture.path("state/offline-store-maintenance").exists());
    assert!(!fixture.fence.exists());
    let mut payload = plan.clone();
    payload.as_object_mut().unwrap().remove("planDigest");
    assert_eq!(
        plan["planDigest"],
        digest(&serde_json::to_vec(&payload).unwrap())
    );
    let receipt = success(fixture.apply(&plan));
    assert_eq!(receipt["state"], "STORE_PREPARED");
    assert_eq!(receipt["containerAdoption"], "NOT_RUN");
    assert_eq!(receipt["providerLaunched"], false);
    assert_eq!(receipt["planDigest"], plan["planDigest"]);
    assert_eq!(
        receipt,
        serde_json::from_slice::<Value>(&fs::read(fixture.receipt_path()).unwrap()).unwrap()
    );
    let audit: Value =
        serde_json::from_slice(&fs::read(fixture.path("prepared-audit")).unwrap()).unwrap();
    assert_eq!(audit, json!({"plan":plan,"state":"PREPARED"}));
    assert_eq!(fs::read(fixture.path("company.json")).unwrap(), before);
    assert_eq!(fs::read(fixture.path("stopped.json")).unwrap(), stopped);
    assert_eq!(fs::read(fixture.path("broker.json")).unwrap(), config);
    assert_eq!(fs::read(fixture.home.join("keep")).unwrap(), b"owner data");
    assert_eq!(fixture.calls(), ["create", "start", "rm"]);
    assert!(!fixture.fence.exists());
    let rejected = error(fixture.command().output().unwrap(), 3, "REFUSED");
    assert!(
        rejected["reason"]
            .as_str()
            .unwrap()
            .contains("already recorded")
    );
    let lease = reverie_host::worker_storage::StorageLease::acquire_launch(
        &fixture.source,
        &fixture.session,
    )
    .unwrap();
    lease.close().unwrap();
}

#[test]
fn held_and_missing_native_locks_refuse_before_fencing() {
    let Some(harness) = Harness::new() else {
        return;
    };
    let fixture = harness.fixture();
    let plan = fixture.plan();
    for path in [&fixture.employee_lock, &fixture.session_lock] {
        let held = File::open(path).unwrap();
        held.try_lock().unwrap();
        error(fixture.apply(&plan), 3, "REFUSED");
        assert!(!fixture.fence.exists());
    }
    fs::remove_file(&fixture.session_lock).unwrap();
    error(fixture.apply(&plan), 3, "REFUSED");
    assert!(!fixture.session_lock.exists());
    assert!(fixture.calls().is_empty());
}

#[test]
fn uncertain_engine_effects_and_foreign_writers_leave_the_broker_fence() {
    let Some(harness) = Harness::new() else {
        return;
    };
    for mode in [
        "create",
        "start",
        "rm",
        "never-exited",
        "add-writer",
        "lose-stopped",
        "stderr-bound",
    ] {
        let fixture = harness.fixture();
        let plan = fixture.plan();
        if ["create", "start", "rm"].contains(&mode) {
            fixture.write("fail", mode.as_bytes());
        } else {
            fixture.write(mode, b"");
        }
        error(fixture.apply(&plan), 4, "UNCONFIRMED");
        assert!(fixture.fence.exists(), "{mode}");
        assert!(!fixture.receipt_path().exists(), "{mode}");
        assert!(
            reverie_host::worker_storage::StorageLease::acquire_launch(
                &fixture.source,
                &fixture.session
            )
            .is_err()
        );
        error(fixture.command().output().unwrap(), 3, "REFUSED");
    }
}

#[test]
fn drift_and_incomplete_closure_never_acknowledge_preparation() {
    let Some(harness) = Harness::new() else {
        return;
    };
    for mode in [
        "drift-company",
        "profile-drift",
        "miss-closure",
        "change-fence",
        "receipt-collision",
        "replace-lock",
    ] {
        let fixture = harness.fixture();
        let plan = fixture.plan();
        fixture.write(mode, b"");
        error(fixture.apply(&plan), 4, "UNCONFIRMED");
        assert!(fixture.fence.exists(), "{mode}");
        if mode == "change-fence" {
            assert_eq!(fs::read(&fixture.fence).unwrap(), b"{\"foreign\":true}");
        }
        if mode == "receipt-collision" {
            assert_eq!(
                fs::read(fixture.receipt_path()).unwrap(),
                b"{\"foreign\":true}"
            );
        } else {
            assert!(!fixture.receipt_path().exists(), "{mode}");
        }
    }
}

#[test]
fn changed_plan_and_host_sandbox_never_start_the_seed() {
    let Some(harness) = Harness::new() else {
        return;
    };
    let fixture = harness.fixture();
    let plan = fixture.plan();
    fixture.change("broker.json", |config| config["cpus"] = 2.into());
    error(fixture.apply(&plan), 3, "REFUSED");
    assert!(!fixture.fence.exists());
    assert!(fixture.calls().is_empty());
    let plan = fixture.plan();
    fixture.change("created.json", |helper| {
        helper["HostConfig"]["Privileged"] = true.into()
    });
    error(fixture.apply(&plan), 4, "UNCONFIRMED");
    assert_eq!(fixture.calls(), ["create"]);
    assert!(fixture.fence.exists());
}

#[test]
fn expired_target_after_create_never_starts_the_seed() {
    let Some(harness) = Harness::new() else {
        return;
    };
    let fixture = harness.fixture();
    fixture.write("slow-create-inspect", b"");
    fixture.change("target.json", |target| {
        target["expiresAtEpoch"] = expiry(6.0).into()
    });
    let plan = fixture.plan();
    error(fixture.apply(&plan), 4, "UNCONFIRMED");
    assert_eq!(fixture.calls(), ["create"]);
    assert!(fixture.fence.exists());
}

#[test]
fn isolated_image_receipt_leaves_runtime_acceptance_pending() {
    let Some(harness) = Harness::new() else {
        return;
    };
    let fixture = harness.fixture();
    fixture.evidence(true);
    let plan = fixture.plan();
    let receipt = success(fixture.apply(&plan));
    assert_eq!(
        receipt["state"],
        "STORE_PREPARED_RUNTIME_ACCEPTANCE_PENDING"
    );
    assert_eq!(receipt["runtimeAcceptance"], "PENDING");
    assert_eq!(
        receipt["validationScope"],
        "VALIDATED_OFFLINE_IMAGE_TOOL_SHELL"
    );
}

#[test]
fn planning_flags_foreign_writers_and_tampered_evidence_without_effects() {
    let Some(harness) = Harness::new() else {
        return;
    };
    let fixture = harness.fixture();
    let mut validation: Value =
        serde_json::from_slice(&fs::read(fixture.path("validation.json")).unwrap()).unwrap();
    validation["Mounts"] =
        json!([{"Type":"bind","Source":fixture.store,"Destination":"/foreign","RW":true}]);
    fixture.write_json("validation.json", &validation);
    error(fixture.command().output().unwrap(), 3, "REFUSED");
    fixture.evidence(false);
    fixture.write("probe", b"independently changed fixture");
    error(fixture.command().output().unwrap(), 3, "REFUSED");
    fixture.evidence(false);
    fs::rename(
        fixture.store.join("var/nix"),
        fixture.store.join("previous"),
    )
    .unwrap();
    symlink(
        fixture.store.join("previous"),
        fixture.store.join("var/nix"),
    )
    .unwrap();
    error(fixture.command().output().unwrap(), 3, "REFUSED");
    assert!(fixture.calls().is_empty());
    assert!(!fixture.fence.exists());
}

#[test]
fn the_plan_refuses_unauthorized_admission_and_controls() {
    let Some(harness) = Harness::new() else {
        return;
    };
    let fixture = harness.fixture();
    assert!(
        fixture
            .command()
            .arg("--help")
            .output()
            .unwrap()
            .status
            .success()
    );
    error(
        fixture.command().arg("--apply").output().unwrap(),
        3,
        "REFUSED",
    );
    fixture.plan();
    fixture.change("target.json", |target| {
        target["budget"]["fullClosureAllocatedBytes"] = u64::MAX.into()
    });
    error(fixture.command().output().unwrap(), 3, "REFUSED");
    fixture.evidence(false);
    fixture.change("company.json", |company| {
        company["employees"][0]["onVacation"] = false.into()
    });
    error(fixture.command().output().unwrap(), 3, "REFUSED");
    assert!(fixture.calls().is_empty());
    assert!(!fixture.fence.exists());
}
