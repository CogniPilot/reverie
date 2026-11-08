use super::*;
#[test]
fn runtime_reader_preserves_its_actual_consumed_close_uncertainty() {
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
    let baseline = tree.fd_count();
    inject(|point, path| {
        if matches!(point, Point::BeforeRead)
            && path.file_name().is_some_and(|name| name == "runtime.json")
        {
            faults::STATE
                .with(|state| state.borrow_mut().close = Some(private_fs::CloseRole::Data));
        }
        Ok(())
    });
    let error = config
        .observe_provider_runtime(&paths)
        .err()
        .expect("actual runtime checked-close refusal");
    faults::reset();
    HOOK.with(|hook| *hook.borrow_mut() = None);
    assert!(error.has_unconfirmed_close());
    assert_eq!(tree.fd_count(), baseline);
    assert!(config.observe_provider_runtime(&paths).is_ok());
    assert!(
        error.has_unconfirmed_close(),
        "later independent known read cannot rewrite original uncertainty"
    );
}
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
