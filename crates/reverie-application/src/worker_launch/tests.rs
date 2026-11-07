use super::*;
use crate::reservation_gate::tests::Tree;
use reverie_contracts::resource_config::ResourceConfiguration;
use reverie_host::worker_identity;
#[test]
fn compatibility_preparation_delegates_actual_observations_and_keeps_original_snapshots() {
    let tree = Tree::new();
    tree.write("company.json", br#"{"employees":[]}"#);
    let captured =
        crate::worker_validation::load_owner_config(&tree.root.join("worker.json")).unwrap();
    let sid = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    let identity = worker_identity::storage_identity(
        &ResourceConfiguration::capture(captured.configuration().clone())
            .unwrap()
            .identity_settings()
            .unwrap(),
    )
    .unwrap();
    let storage = reverie_store::storage_identity::storage_paths(&identity, &sid).unwrap();
    let plan = prepare_create(&captured, &sid, &storage).unwrap();
    assert!(reverie_contracts::worker_config::equivalent(
        plan.source(),
        captured.configuration()
    ));
    assert_eq!(plan.storage(), &storage);
    assert_eq!(plan.session(), &sid);
    let other = ProfileSessionId::parse("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap();
    std::fs::remove_file(tree.root.join("worker.json")).unwrap();
    assert!(matches!(
        prepare_create(&captured, &other, &storage),
        Err(LaunchPreparationError::StorageSession)
    ));
}
