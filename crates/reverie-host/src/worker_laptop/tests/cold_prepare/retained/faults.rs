//! Real no-replace collisions, acknowledged syscalls with deliberately lost
//! replies, and actual checked-close failure. No old-tree rollback/cleanup.
use super::*;
use crate::worker_storage::{RetainedColdFault as Fault, set_retained_cold_fault};
fn name(fault: Fault) -> &'static str {
    match fault {
        Fault::RetireCollision => "retire collision",
        Fault::LostRetireReply => "lost retire reply",
        Fault::InstallCollision => "install collision",
        Fault::LostInstallReply => "lost install reply",
        Fault::PrepareClose => "prepare close",
        Fault::FinishClose => unreachable!("finish belongs to full chain"),
    }
}
#[test]
fn foreign_targets_lost_rename_replies_and_failed_close_keep_every_owned_or_foreign_byte() {
    if isolate(
        "faults::foreign_targets_lost_rename_replies_and_failed_close_keep_every_owned_or_foreign_byte",
    ) {
        return;
    }
    for fault in [
        Fault::RetireCollision,
        Fault::LostRetireReply,
        Fault::InstallCollision,
        Fault::LostInstallReply,
        Fault::PrepareClose,
    ] {
        let mut fixture = Fixture::new("created-cold");
        let (nix, plan, request, target) = inputs(&mut fixture);
        fs::write(target.join("payload"), b"never discard original bytes").unwrap();
        let old = fs::metadata(&target).unwrap();
        set_retained_cold_fault(fault);
        assert!(
            fixture
                .runtime()
                .prepare_retained_cold_tmp(&nix, &plan, end())
                .is_err(),
            "{}",
            name(fault)
        );
        let retired = envelope(&plan);
        let original = if fault == Fault::RetireCollision {
            target.clone()
        } else {
            retired.join("data")
        };
        assert_eq!(
            fs::metadata(&original).unwrap().ino(),
            old.ino(),
            "{}",
            name(fault)
        );
        assert_eq!(
            fs::read(original.join("payload")).unwrap(),
            b"never discard original bytes"
        );
        match fault {
            Fault::RetireCollision => assert_eq!(
                fs::read(retired.join("data/foreign")).unwrap(),
                b"foreign collision bytes stay untouched"
            ),
            Fault::InstallCollision => assert_eq!(
                fs::read(target.join("foreign")).unwrap(),
                b"foreign collision bytes stay untouched"
            ),
            Fault::LostRetireReply => assert!(!target.exists()),
            Fault::LostInstallReply | Fault::PrepareClose => assert!(target.is_dir()),
            Fault::FinishClose => unreachable!("finish belongs to full chain"),
        }
        assert!(retired.join(".keep").is_file());
        let pending = plan.storage().root().join("cold-tmp-cleanup.pending.json");
        let raw = fs::read(&pending).unwrap();
        let trace = fs::read(fixture.root.join("trace")).unwrap();
        assert!(
            fixture
                .runtime()
                .prepare_retained_cold_tmp(&nix, &plan, end())
                .is_err()
        );
        assert_eq!(fs::read(&pending).unwrap(), raw);
        assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
        let phone = fixture
            .office
            .bind(fixture.root.join("api").join(SID), sid())
            .unwrap();
        assert!(
            fixture
                .runtime()
                .retain_laptop_network(&nix, plan, request, phone)
                .is_err()
        );
        assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
        assert!(!fixture.root.join("created-network").exists());
    }
}
