//! Space arithmetic over stated volumes, and the actual service refusing a
//! bad rehearsal directory before any Engine request.
use super::*;
use crate::service::rollback::network_tests::fixture::Fixture;
use std::{fs, os::unix::fs::PermissionsExt};

const GIB: u64 = 1 << 30;

fn namespace(test: &str, scenario: fn()) {
    crate::test_namespace::run(
        &format!("service::apply::preflight::tests::{test}"),
        scenario,
    );
}
/// A measured console of one sparse file with the given apparent size.
fn console(bytes: u64) -> ConsoleEstimate {
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random).unwrap();
    let name: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let root = std::env::temp_dir().join(format!("reverie-preflight-{name}"));
    fs::create_dir_all(root.join("console")).unwrap();
    fs::File::create(root.join("console/data"))
        .unwrap()
        .set_len(bytes)
        .unwrap();
    let estimate = estimate_console(&root, Instant::now() + Duration::from_secs(30)).unwrap();
    fs::remove_dir_all(root).unwrap();
    assert_eq!(estimate.regular_bytes(), bytes);
    estimate
}
fn volume(device: u64, available: u64) -> Volume {
    Volume { device, available }
}

#[test]
fn one_filesystem_must_hold_the_archive_and_the_rehearsal_together() {
    let estimate = console(27 * GIB);
    let both = estimate.archive_bytes() + estimate.rehearsal_bytes();
    assert!(both > 54 * GIB);
    let report = storage_report(&estimate, volume(1, 349 * GIB), None);
    assert_eq!(report["sufficient"], true);
    assert_eq!(report["consoleRegularBytes"], 27 * GIB);
    assert_eq!(report["consoleEntries"], 2);
    let rows = report["filesystems"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["holds"], json!(["archive", "rehearsal"]));
    assert_eq!(rows[0]["requiredBytes"], required(both));
    assert_eq!(rows[0]["availableBytes"], 349 * GIB);
    // Room for one copy is not room for the update.
    let short = storage_report(&estimate, volume(1, 40 * GIB), None);
    assert_eq!(short["sufficient"], false);
    assert_eq!(short["filesystems"][0]["sufficient"], false);
    // The margin is part of the requirement.
    let exact = storage_report(&estimate, volume(1, required(both)), None);
    assert_eq!(exact["sufficient"], true);
    let under = storage_report(&estimate, volume(1, required(both) - 1), None);
    assert_eq!(under["sufficient"], false);
}

#[test]
fn a_separate_rehearsal_disk_is_measured_on_its_own() {
    let estimate = console(27 * GIB);
    let tar = Some((volume(2, 200 * GIB), BackupFormat::Tar));
    let report = storage_report(&estimate, volume(1, 40 * GIB), tar);
    assert_eq!(report["sufficient"], true);
    let rows = report["filesystems"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["holds"], json!(["archive"]));
    assert_eq!(rows[0]["requiredBytes"], required(estimate.archive_bytes()));
    assert_eq!(rows[1]["holds"], json!(["rehearsal"]));
    assert_eq!(
        rows[1]["requiredBytes"],
        required(estimate.rehearsal_bytes())
    );
    // A full rehearsal disk refuses although the operation disk has room.
    let full = Some((volume(2, 10 * GIB), BackupFormat::Tar));
    let report = storage_report(&estimate, volume(1, 400 * GIB), full);
    assert_eq!(report["sufficient"], false);
    assert_eq!(report["filesystems"][0]["sufficient"], true);
    assert_eq!(report["filesystems"][1]["sufficient"], false);
}

#[test]
fn a_rehearsal_directory_on_the_same_filesystem_shares_one_requirement() {
    let estimate = console(27 * GIB);
    let same = Some((volume(1, 60 * GIB), BackupFormat::Tar));
    let report = storage_report(&estimate, volume(1, 60 * GIB), same);
    let rows = report["filesystems"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["holds"], json!(["archive", "rehearsal"]));
    assert_eq!(report["sufficient"], true);
    let tight = Some((volume(1, 50 * GIB), BackupFormat::Tar));
    let report = storage_report(&estimate, volume(1, 50 * GIB), tight);
    assert_eq!(report["sufficient"], false);
}

#[test]
fn a_compressed_backup_stages_both_copies_on_the_rehearsal_disk() {
    let estimate = console(27 * GIB);
    let gzip = Some((volume(2, 200 * GIB), BackupFormat::Gzip));
    let report = storage_report(&estimate, volume(1, GIB), gzip);
    assert_eq!(report["sufficient"], true);
    let rows = report["filesystems"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["holds"], json!(["archive", "rehearsal"]));
    let small = Some((volume(2, 40 * GIB), BackupFormat::Gzip));
    let report = storage_report(&estimate, volume(1, 400 * GIB), small);
    assert_eq!(report["sufficient"], false);
}

#[test]
fn a_wrong_rehearsal_root_refuses_apply_before_any_engine_request() {
    namespace(
        "a_wrong_rehearsal_root_refuses_apply_before_any_engine_request",
        || {
            // This fixture binds the console data the way a real office does.
            let f = Fixture::adopting();
            let operation = f.operation.plan.operation.clone();
            let refused = |path: &str| {
                let error = f
                    .service
                    .apply_with_rehearsal_root(&operation, Path::new(path))
                    .err()
                    .unwrap();
                assert_eq!(error.code(), "DEPLOYMENT_REHEARSAL_ROOT_REFUSED", "{path}");
                assert!(error.source_restore().is_none());
                error.snapshot_error().unwrap().code()
            };
            assert_eq!(
                refused("/tmp/never-created"),
                "SNAPSHOT_REHEARSAL_ROOT_MISSING"
            );
            assert_eq!(refused("relative"), "SNAPSHOT_REHEARSAL_ROOT");
            fs::create_dir("/tmp/open").unwrap();
            fs::set_permissions("/tmp/open", fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(refused("/tmp/open"), "SNAPSHOT_DESTINATION_CUSTODY");
            fs::set_permissions("/tmp/open", fs::Permissions::from_mode(0o700)).unwrap();
            fs::write("/tmp/open/left-over", b"earlier rehearsal").unwrap();
            assert_eq!(refused("/tmp/open"), "SNAPSHOT_REHEARSAL_OCCUPIED");
            assert!(f.port.calls().is_empty());
            assert!(!f.operation.exists("stop-attempt"));
            f.close();
        },
    );
}

#[test]
fn storage_is_reported_for_the_running_office_without_any_effect() {
    namespace(
        "storage_is_reported_for_the_running_office_without_any_effect",
        || {
            let f = Fixture::live_accounts();
            f.port
                .set("/containers/fixture/json".into(), f.source.clone());
            fs::write("/tmp/deployment/data/console/data", vec![1; 4096]).unwrap();
            let report = f.service.check_backup_storage(None, false).unwrap();
            assert_eq!(report["sufficient"], true);
            assert_eq!(report["consoleRegularBytes"], 4096);
            assert_eq!(report["filesystems"].as_array().unwrap().len(), 1);
            let missing = f
                .service
                .check_backup_storage(Some(Path::new("/tmp/never-created")), false)
                .err()
                .unwrap();
            assert_eq!(missing.code(), "DEPLOYMENT_REHEARSAL_ROOT_REFUSED");
            fs::create_dir("/tmp/rehearsal").unwrap();
            fs::set_permissions("/tmp/rehearsal", fs::Permissions::from_mode(0o700)).unwrap();
            for compress in [false, true] {
                let report = f
                    .service
                    .check_backup_storage(Some(Path::new("/tmp/rehearsal")), compress)
                    .unwrap();
                assert_eq!(report["sufficient"], true, "{compress}");
            }
            // Nothing was created in the rehearsal or the operation storage.
            assert!(fs::read_dir("/tmp/rehearsal").unwrap().next().is_none());
            assert!(
                !Path::new("/tmp/deployment/runtime/update-state/console-deployments/snapshot")
                    .exists()
            );
            assert!(f.port.posts().is_empty());
            f.close();
        },
    );
}

#[test]
fn the_preview_states_what_the_stop_will_copy_or_why_it_could_not_measure() {
    namespace(
        "the_preview_states_what_the_stop_will_copy_or_why_it_could_not_measure",
        || {
            let f = Fixture::live_accounts();
            fs::write("/tmp/deployment/data/console/data", vec![1; 4096]).unwrap();
            let measured = f.service.stopped_backup(&f.source);
            let estimate = measured.estimate.unwrap();
            assert_eq!(estimate.console_regular_bytes, 4096);
            // console, accounts, profile and the file.
            assert_eq!(estimate.console_entries, 4);
            assert_eq!(
                estimate.bytes_written_while_stopped,
                estimate.archive_bytes + estimate.rehearsal_bytes
            );
            assert!(estimate.bytes_read_while_stopped > estimate.bytes_written_while_stopped);
            assert!(measured.estimate_refusal.is_none());
            let mut elsewhere = f.source.clone();
            elsewhere["Mounts"][0]["Destination"] = json!("/somewhere/else");
            let refused = f.service.stopped_backup(&elsewhere);
            assert!(refused.estimate.is_none());
            assert_eq!(
                refused.estimate_refusal.as_deref(),
                Some("DEPLOYMENT_DATA_BIND_REQUIRED")
            );
            assert!(f.port.calls().is_empty());
            f.close();
        },
    );
}
