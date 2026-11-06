use super::*;
use std::os::unix::fs::symlink;
fn mount(source: &std::path::Path, destination: &str) -> serde_json::Value {
    json!({"Type":"bind","Source":source,"Destination":destination,"RW":true})
}
#[test]
fn original_accounts_use_owned_source_and_proc_identities_sorting_only_after_source_reads() {
    let fixture = Fixture::new();
    let first = fixture.root.join("first");
    let second = fixture.root.join("second");
    fs::create_dir(&first).unwrap();
    fs::create_dir(&second).unwrap();
    for (destination, source) in [
        ("/instances/default/accounts/z", &first),
        ("/instances/default/console/accounts/a", &second),
    ] {
        fixture.identity_paths.borrow_mut().insert(
            path(&format!("/proc/123/root{destination}")).codepoints(),
            PosixPath::try_new(&native::python_text(source)).unwrap(),
        );
    }
    let raw = fixture.row_with_mounts(json!([
        mount(&first, "/instances/default/accounts/z"),
        mount(&second, "/instances/default/console/accounts/a")
    ]));
    let row = &raw.rows()[0];
    let limits = limits::observe(&fixture, row, None, end()).unwrap();
    let tail = baseline::observe(&fixture, row, limits.binding(), end()).unwrap();
    let group = fs::symlink_metadata(fixture.actual(&path("/sys/fs/cgroup/worker"))).unwrap();
    assert_eq!(tail.cgroup_identity(), [group.dev(), group.ino()]);
    assert_eq!(tail.accounts().len(), 2);
    assert_eq!(
        tail.accounts()[0].destination().scalar_text().unwrap(),
        "/instances/default/accounts/z"
    );
    assert_eq!(
        tail.accounts()[1].destination().scalar_text().unwrap(),
        "/instances/default/console/accounts/a"
    );
    assert_eq!(
        tail.accounts()[0].identity(),
        native::reservation_identity_text(&native::python_text(&first)).unwrap()
    );
    source_release::accounts(&fixture, &tail, end()).unwrap();
    fixture.identity_paths.borrow_mut().insert(
        path("/proc/123/root/instances/default/accounts/z").codepoints(),
        PosixPath::try_new(&native::python_text(&second)).unwrap(),
    );
    assert_eq!(
        baseline::observe(&fixture, row, limits.binding(), end())
            .err()
            .unwrap()
            .code(),
        "RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED"
    );
}
#[test]
fn terminal_accounts_use_original_order_and_a_changed_first_source_precedes_later_missing_source() {
    let fixture = Fixture::new();
    let first = fixture.root.join("first");
    let second = fixture.root.join("second");
    fs::create_dir(&first).unwrap();
    fs::create_dir(&second).unwrap();
    let rows = fixture.row_with_mounts(json!([
        mount(&first, "/instances/default/accounts/z"),
        mount(&second, "/instances/default/console/accounts/a")
    ]));
    let mut declarations =
        reverie_contracts::reservation_baseline::AccountDeclarations::new(&rows.rows()[0]).unwrap();
    let mut accounts = Vec::new();
    while let Some(declaration) = declarations.next_declaration().unwrap() {
        let selected = declaration.source().unwrap();
        accounts.push(
            declaration
                .observe(native::reservation_identity_text(selected.codepoints()).unwrap())
                .unwrap(),
        );
    }
    let tail = reverie_contracts::reservation_baseline::OriginalRuntimeTail::from_observed_data(
        [1, 2],
        accounts,
    );
    source_release::accounts(&fixture, &tail, end()).unwrap();
    fs::rename(&first, fixture.root.join("preserved-first")).unwrap();
    fs::create_dir(&first).unwrap();
    fs::remove_dir(&second).unwrap();
    assert_eq!(
        source_release::accounts(&fixture, &tail, end())
            .unwrap_err()
            .code(),
        "RESOURCE_NATIVE_ACCOUNT_BINDING_CHANGED"
    );
}
#[test]
fn first_source_io_and_cgroup_identity_refusals_are_not_hidden_by_later_bad_mounts() {
    let fixture = Fixture::new();
    let missing = fixture.root.join("missing");
    let raw = fixture.row_with_mounts(
        json!([mount(&missing,"/instances/default/accounts/a"),{"Destination":false}]),
    );
    let row = &raw.rows()[0];
    let limits = limits::observe(&fixture, row, None, end()).unwrap();
    let error = baseline::observe(&fixture, row, limits.binding(), end())
        .err()
        .unwrap();
    assert!(
        matches!(error,ReservationKernelError::Observation(ObservationError::Io(ref cause)) if cause.kind()==io::ErrorKind::NotFound)
    );
    let group = fixture.actual(&path("/sys/fs/cgroup/worker"));
    let kept = group.with_file_name("kept");
    fs::rename(&group, &kept).unwrap();
    symlink("kept", &group).unwrap();
    assert_eq!(
        baseline::observe(&fixture, row, limits.binding(), end())
            .err()
            .unwrap()
            .code(),
        "RESOURCE_NATIVE_CGROUP_REQUIRED"
    );
}
#[test]
fn raw_identity_open_preserves_file_trailing_separator_and_dot_failures() {
    let fixture = Fixture::new();
    let source = fixture.root.join("file");
    fs::write(&source, b"owned").unwrap();
    let value = source.to_str().unwrap().to_owned() + "/.";
    let raw=fixture.row_with_mounts(json!([{"Type":"bind","Source":value,"Destination":"/instances/default/accounts/a","RW":true}]));
    let row = &raw.rows()[0];
    let limits = limits::observe(&fixture, row, None, end()).unwrap();
    let error = baseline::observe(&fixture, row, limits.binding(), end())
        .err()
        .unwrap();
    assert!(
        matches!(error,ReservationKernelError::Observation(ObservationError::Io(ref cause)) if cause.raw_os_error()==Some(libc::ENOTDIR)),
        "raw str opens must not be normalized into a different refusal"
    );
}
