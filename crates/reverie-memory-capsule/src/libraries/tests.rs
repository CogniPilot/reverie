use super::*;
#[test]
#[ignore = "requires explicit immutable two-origin ELF fixture and maintained tool paths"]
fn equal_bytes_at_distinct_origins_cannot_hide_conflicting_dependency_contents() {
    let root = PathBuf::from(std::env::var_os("REVERIE_TEST_CAPSULE_ORIGINS").unwrap())
        .canonicalize()
        .unwrap();
    assert!(root.starts_with("/nix/store"));
    assert_eq!(
        fs::read(root.join("a/libsame.so")).unwrap(),
        fs::read(root.join("b/libsame.so")).unwrap()
    );
    assert_ne!(
        fs::read(root.join("a/libprivate.so")).unwrap(),
        fs::read(root.join("b/libprivate.so")).unwrap()
    );
    let tools = Tools::new(
        &PathBuf::from(std::env::var_os("REVERIE_TEST_CAPSULE_PATCHELF").unwrap()),
        &PathBuf::from(std::env::var_os("REVERIE_TEST_CAPSULE_READELF").unwrap()),
    )
    .unwrap();
    let mut libraries = Libraries::new(&root.join("closure")).unwrap();
    libraries.include(&root.join("a/root.so"), &tools).unwrap();
    let second = libraries.include(&root.join("b/root.so"), &tools);
    assert!(
        second.is_err_and(|e| e.to_string().contains("conflicting library contents")),
        "second origin must be traversed and its conflicting child refused"
    );
}
