//! Controlled native manager/read-only fixture + actual FS/flocks/CAS. This
//! proves no real installed manager, Docker image or application permission.
use super::*;
use crate::worker_image::{ImageControlFiles, ImageMaintenanceLocks};
use reverie_contracts::worker_image_switch::{ImagePinTransition, WorkerImageId};
use reverie_core::operations::{JournalDigest, JournalId};

fn private(path: &Path, raw: &[u8]) {
    fs::write(path, raw).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn setup(root: &Path, source: &Path) -> reverie_contracts::worker_config::EffectiveWorkerConfig {
    let registered = root.join("reverie");
    for dir in [
        "data/console",
        "runtime/update-state",
        "state",
        "control/profiles",
        "control/operations",
    ] {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(registered.join(dir))
            .unwrap();
    }
    let raw = serde_json::json!({"uid":native::policy_effective_uid(),"serverContainer":"office","companyRoot":registered.join("data"),"companyFile":registered.join("data/console/company.json"),"stateRoot":registered.join("state"),"resourceReservations":{"directory":registered.join("control")},"image":format!("sha256:{}","a".repeat(64))});
    private(source, &serde_json::to_vec(&raw).unwrap());
    private(
        &registered.join("deployment.json"),
        &serde_json::to_vec(
            &serde_json::json!({"version":1,"containerName":"office","companyRoot":registered}),
        )
        .unwrap(),
    );
    private(
        &registered.join("runtime/update-state/update.lock"),
        b"maintenance",
    );
    private(
        &registered.join("state/resource-reservation-control.json"),
        b"{\"preserved\":true}",
    );
    for file in [
        "control/admission.lock",
        "control/profiles/profiles.lock",
        "control/operations/operations.lock",
    ] {
        private(&registered.join(file), b"");
    }
    private(
        &registered.join("control/operations/operations.json"),
        b"{\"preserved\":true}",
    );
    reverie_contracts::worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap()
}

#[test]
fn maintained_cas_must_refuse_late_replacement_of_every_original_outer_fence() {
    let mut results = Vec::new();
    for target in [
        None,
        Some("deployment.json"),
        Some("runtime/update-state/update.lock"),
        Some(".worker-image.lock"),
        Some("worker-pool/service/pending"),
    ] {
        let (proof, root, _program) = native_image_fixture();
        let source = proof.source().to_owned();
        let config = setup(&root, &source);
        let end = proof.end();
        let service = proof.begin_image_transition().unwrap();
        let mut locks =
            ImageMaintenanceLocks::capture_fixture(&root.join("reverie"), &source, &config, end)
                .unwrap();
        let mut files = ImageControlFiles::capture(&source, &config);
        let before = files.read_configuration().unwrap();
        let intent = Arc::new(
            ImagePinTransition::prepare(
                before.bytes(),
                &WorkerImageId::parse(&format!("sha256:{}", "a".repeat(64))).unwrap(),
                WorkerImageId::parse(&format!("sha256:{}", "b".repeat(64))).unwrap(),
                JournalId::parse("11111111-1111-4111-8111-111111111111").unwrap(),
                JournalDigest::parse(&"c".repeat(64)).unwrap(),
            )
            .unwrap(),
        );
        let pending = files.publish_pending(intent.clone(), end).unwrap();
        let protected = files.protected_stores().unwrap();
        locks.assert_held_current().unwrap();
        if let Some(relative) = target {
            crate::gpu_access::image_path_swap_before_cas_fixture_fault(
                root.join("reverie").join(relative),
            );
        }
        let result = files.publish_maintained_configuration(
            &intent,
            before.stamp(),
            &pending,
            &mut locks,
            &service,
        );
        crate::gpu_access::clear_image_fixture_faults();
        let bytes = fs::read(&source).unwrap();
        if target.is_none() {
            let publication = result.as_ref().unwrap();
            let terminal = files
                .capture_terminal(publication, &pending, &protected)
                .unwrap();
            let mut pending = pending;
            files.release_pending(&mut pending, &terminal).unwrap();
        }
        let lock_close = locks.close();
        if let Err(mut failure) = lock_close {
            failure.close_components().unwrap();
        }
        let service_close = service.close();
        match service_close {
            Ok(closed) if target.is_none() => {
                let _closed_service = closed.release().unwrap();
            }
            Ok(closed) => drop(closed),
            Err(mut failure) => {
                failure.close_components().unwrap();
            }
        }
        // All original native descriptors/processes settled before verdict.
        // Remaining private pending DATA is not a production cleanup ACK.
        results.push(match target {
            None => result.is_ok() && bytes == intent.configuration_bytes(),
            Some(_) => result.is_err() && bytes == before.bytes(),
        });
        fs::remove_dir_all(&root).unwrap();
    }
    assert_eq!(
        results,
        [true, true, true, true, true],
        "every actual late outer-fence replacement must refuse before configuration rename"
    );
}
