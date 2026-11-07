//! Actual bound publication/close failure and actual final confirmation drift;
//! a durable result never substitutes for the still-present pending fence.
use super::*;
use crate::worker_storage::{RetainedColdFault, set_retained_cold_fault};
#[test]
fn refused_finalizer_or_changed_final_cid_keeps_bound_record_and_pending_without_token() {
    if isolate(
        "finish::faults::refused_finalizer_or_changed_final_cid_keeps_bound_record_and_pending_without_token",
    ) {
        return;
    }
    for failed_close in [false, true] {
        let mut fixture = Fixture::new("created-retained");
        let (nix, plan, request, target) = inputs(&mut fixture);
        fs::write(target.join("payload"), b"never delete retired bytes").unwrap();
        prepare(&fixture, &nix, &plan);
        let retired = envelope(&plan);
        let control = plan.storage().root().to_owned();
        let pending = control.join("cold-tmp-cleanup.pending.json");
        let expected = fs::read(&pending).unwrap();
        let (workflow, configured) = configured(&fixture, &nix, plan, request);
        let binding = TmpBind::new(&target);
        let row = inspection(&fixture, &target);
        fs::write(
            fixture.root.join("retained-inspect.json"),
            serde_json::to_vec(&row).unwrap(),
        )
        .unwrap();
        if failed_close {
            set_retained_cold_fault(RetainedColdFault::FinishClose);
        } else {
            let mut changed = row;
            changed[0]["Id"] = json!("f".repeat(64));
            fs::write(
                fixture.root.join("retained-inspect-next.json"),
                serde_json::to_vec(&changed).unwrap(),
            )
            .unwrap();
        }
        let result = fixture
            .runtime()
            .commit_started_laptop_cold(&configured, end())
            .unwrap();
        if failed_close {
            assert!(matches!(result, ColdCommit::Retained));
        } else {
            assert!(matches!(result, ColdCommit::Rejected));
        }
        assert_eq!(fs::read(&pending).unwrap(), expected);
        assert_eq!(
            fs::read(retired.join("data/payload")).unwrap(),
            b"never delete retired bytes"
        );
        let count = fs::read_to_string(fixture.root.join("retained-inspect-count")).unwrap();
        assert_eq!(
            count,
            if failed_close { "2" } else { "3" },
            "first/last actual confirmation ordering"
        );
        let bound = fs::read_dir(&control)
            .unwrap()
            .filter_map(|entry| {
                let entry = entry.unwrap();
                let name = entry.file_name();
                let name = name.to_str().unwrap();
                (name.starts_with("cold-tmp-retained-")
                    && !name.starts_with("cold-tmp-retained-ready-"))
                .then(|| entry.path())
            })
            .collect::<Vec<_>>();
        assert_eq!(bound.len(), 1);
        let raw: serde_json::Value = serde_json::from_slice(&fs::read(&bound[0]).unwrap()).unwrap();
        assert_eq!(
            raw["state"],
            "OLD_TMP_RETAINED_FRESH_TMP_BOUND_PENDING_RELEASE"
        );
        assert_eq!(
            raw["requiresAbsentFenceForUse"],
            "cold-tmp-cleanup.pending.json"
        );
        assert_eq!(raw["oldDataDeleted"], false);
        let trace = fs::read(fixture.root.join("trace")).unwrap();
        assert!(
            fixture
                .runtime()
                .commit_started_laptop_cold(&configured, end())
                .is_err()
        );
        assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
        assert!(workflow.failure().unwrap().is_some());
        // Even after the actual local descriptors closed, the library outcome
        // remains negative. This probe grants no lease/capacity credit.
        let barrier = control.join("home/.local/state/reverie/leases/barrier.lock");
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(barrier)
            .unwrap();
        file.try_lock().unwrap();
        crate::native::close(file).unwrap();
        binding.close();
    }
}
