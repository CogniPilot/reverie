use super::*;
#[test]
fn runtime_publication_and_marker_changes_refuse_original_observation() {
    let tree = Tree::new();
    let config = tree.config();
    let paths = storage_paths(&config, &session(A)).unwrap();
    let launch = paths.home().join(".reverie-launch");
    fs::create_dir_all(&launch).unwrap();
    fs::set_permissions(&launch, fs::Permissions::from_mode(0o700)).unwrap();
    tree.write(
        &tree.state().join(A).join("runtime.json"),
        &format!("{{\"exit\":\"{B}.exit\"}}"),
    );
    let observation = config.observe_provider_runtime(&paths).unwrap();
    assert!(!observation.completed());
    assert!(!observation.starting());
    observation.assert_current(&config).unwrap();
    tree.write(&launch.join(format!("{B}.json")), "{}");
    assert!(observation.assert_current(&config).is_err());
    let starting = config.observe_provider_runtime(&paths).unwrap();
    assert!(starting.starting());
    tree.write(&launch.join(format!("{B}.exit")), "0");
    assert!(starting.assert_current(&config).is_err());
    assert!(config.observe_provider_runtime(&paths).unwrap().completed());
}
