//! Explicit readonly source-package qualification; never execute or mount it.
use reverie_core::lease_policy::LeaseAbsolutePath;
use reverie_host::lease_policy::observe_peer_artifact;

#[test]
#[ignore = "requires separately built immutable source artifact and independent legacy receipt"]
fn qualifies_immutable_peer_artifact_read() {
    let path = std::env::var("REVERIE_TEST_STATIC_PRODUCTION")
        .expect("explicit immutable source package artifact");
    let sha = std::env::var("REVERIE_TEST_STATIC_SHA256").expect("independent legacy byte hash");
    let inode =
        std::env::var("REVERIE_TEST_STATIC_INODE").expect("independent legacy inode observation");
    let observed =
        observe_peer_artifact(&LeaseAbsolutePath::from_scalar_text(&path).unwrap()).unwrap();
    assert_eq!(observed.digest().to_hex(), sha);
    assert_eq!(observed.inode().legacy_text(), inode);
    assert_eq!(observed.path(), std::path::Path::new(&path));
}
