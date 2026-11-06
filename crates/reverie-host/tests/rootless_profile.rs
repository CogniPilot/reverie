//! Explicit readonly qualification against the existing immutable source profile.
use reverie_contracts::{rootless::RootlessConfig, worker_config};
use reverie_host::rootless::observe_rootless;
use sha2::{Digest, Sha256};
#[test]
#[ignore = "requires independently selected immutable Nix source profile; performs no execution"]
fn qualifies_actual_nix_profile_and_accepted_pathlib_aliases_without_engine_use() {
    let path =
        std::env::var("REVERIE_TEST_ROOTLESS_PROFILE").expect("qualified source profile path");
    let raw = std::fs::read(&path).unwrap();
    let digest = format!("{:x}", Sha256::digest(&raw));
    let leaf = path.strip_prefix("/nix/store/").unwrap();
    for value in [
        path.clone(),
        format!("/nix//store/./{leaf}"),
        format!("///nix/store/{leaf}/"),
    ] {
        let config=RootlessConfig::capture(worker_config::decode(&serde_json::to_vec(&serde_json::json!({"uid":1000,"gid":100,"rootlessDocker":{"enabled":true,"seccompProfile":value,"seccompSha256":digest}})).unwrap()).unwrap()).unwrap();
        let observed = observe_rootless(&config).unwrap();
        assert!(observed.enabled());
        assert!(
            observed
                .security_args()
                .iter()
                .any(|text| text.scalar_text() == Some(format!("seccomp={value}")))
        );
    }
}
