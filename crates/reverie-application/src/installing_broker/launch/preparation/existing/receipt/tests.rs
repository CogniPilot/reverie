use super::super::super::tests::{broker, end, finish_claimed};
use super::super::tests::observe;
use super::*;
use crate::reservation_gate::tests::Tree;
use std::{fs, os::unix::fs::symlink};

#[test]
fn actual_runtime_leaf_aliases_and_absolute_exit_data_match_existing_legacy_reader() {
    for alias in ["symlink", "hardlink"] {
        let tree = Tree::new();
        let broker = broker(&tree);
        tree.write("company.json", br#"{"employees":[]}"#);
        let observed = observe(&broker);
        let policy = observed.plan.arguments().policy_digest().to_hex();
        tree.write("inspect.out", &serde_json::to_vec(&serde_json::json!([{"Config":{"Labels":{"reverie.worker":"test","reverie.session":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","reverie.worker-policy":policy}},"State":{"Running":true}}])).unwrap());
        let outside = tree.root.join("owned-receipt");
        fs::write(&outside, b"0").unwrap();
        let metadata = tree.root.join("runtime-target");
        fs::write(
            &metadata,
            serde_json::to_vec(&serde_json::json!({"exit":outside})).unwrap(),
        )
        .unwrap();
        let leaf = tree
            .root
            .join("state/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/runtime.json");
        if alias == "symlink" {
            symlink(&metadata, &leaf).unwrap();
        } else {
            fs::hard_link(&metadata, &leaf).unwrap();
        }
        let before = fs::read(&metadata).unwrap();
        let runtime = observed
            .inspect(end())
            .unwrap_or_else(|e| panic!("{}", e.cause))
            .verify_running()
            .unwrap_or_else(|e| panic!("{}", e.cause))
            .read_runtime()
            .unwrap_or_else(|e| panic!("{}", e.cause));
        let receipt = runtime.receipt.as_ref().unwrap();
        assert!(receipt.exists());
        assert_eq!(
            receipt.exit_path_data().codepoints(),
            reverie_core::posix_text::decode(outside.as_os_str().as_encoded_bytes())
        );
        assert_eq!(
            fs::read(&metadata).unwrap(),
            before,
            "read never overwrites an alias target"
        );
        assert!(broker.installed.laptops.try_lock().is_err());
        finish_claimed(runtime.verified.existing.observed.claimed);
        broker.close_command_telemetry(end()).unwrap();
    }
}

#[test]
fn runtime_read_is_skipped_for_actual_absent_inspect_and_preserves_error_owner_when_running() {
    for running in [false, true] {
        let tree = Tree::new();
        let broker = broker(&tree);
        tree.write("company.json", br#"{"employees":[]}"#);
        let observed = observe(&broker);
        let policy = observed.plan.arguments().policy_digest().to_hex();
        tree.write("inspect.out", &serde_json::to_vec(&serde_json::json!([{"Config":{"Labels":{"reverie.worker":"test","reverie.session":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","reverie.worker-policy":policy}},"State":{"Running":true}}])).unwrap());
        tree.write("inspect.out.status", if running { b"0" } else { b"7" });
        let result = observed
            .inspect(end())
            .unwrap_or_else(|e| panic!("{}", e.cause))
            .verify_running()
            .unwrap_or_else(|e| panic!("{}", e.cause))
            .read_runtime();
        if running {
            let failure = result.err().unwrap();
            assert!(failure.storage.is_some() && failure.active.is_some());
            let claimed = ClaimedWorkerLaunch {
                preparing: failure.preparing,
                storage: failure.storage,
                active: failure.active,
                observed: failure.observed.unwrap(),
                lifecycle: broker.installed.lifecycle().unwrap(),
            };
            finish_claimed(claimed);
        } else {
            let runtime = result.unwrap_or_else(|e| panic!("{}", e.cause));
            assert!(runtime.receipt.is_none());
            finish_claimed(runtime.verified.existing.observed.claimed);
        }
        broker.close_command_telemetry(end()).unwrap();
    }
}
