//! Build-only real-archive controls. No engine, image load or runtime authority.
#[path = "pool_image_inputs/fixture.rs"]
mod fixture;
use fixture::{Fixture, hash};
use serde_json::Value;
use std::fs;

#[test]
fn actual_two_archives_are_measured_in_their_fixed_roles_and_output_is_exclusive() {
    let fixture = Fixture::new();
    let first = fixture.run(false);
    if !first.status.success() {
        panic!(
            "new fixed archive producer refused: {}; retained {}",
            String::from_utf8_lossy(&first.stderr),
            fixture.root.display()
        );
    }
    let original = fs::read(&fixture.output).unwrap();
    let value: Value = serde_json::from_slice(&original).unwrap();
    let repeated = fixture.run(false);
    let after = fs::read(&fixture.output).unwrap();
    let controller = fs::read(&fixture.controller.path).unwrap();
    let anchor = fs::read(&fixture.anchor.path).unwrap();
    let controller_config = fs::read(
        fixture
            .controller
            .root
            .join(&fixture.controller.config_name),
    )
    .unwrap();
    let source_file = fs::read(fixture.source.join("nix/worker-pool-anchor-image.nix")).unwrap();
    fixture.close();
    assert_eq!(value["version"], 1);
    assert_eq!(value["purpose"], "worker-pool-image-inputs-v1");
    assert_eq!(value["system"], "x86_64-linux");
    assert_eq!(value["controller"]["archive"]["sha256"], hash(&controller));
    assert_eq!(value["anchor"]["archive"]["sha256"], hash(&anchor));
    assert_eq!(
        value["controller"]["archiveConfigSHA256"],
        hash(&controller_config)
    );
    assert_eq!(
        value["controller"]["imageSpec"]["Config"]["Entrypoint"][0],
        "/bin/reverie-worker-resource-controller"
    );
    assert_eq!(value["anchor"]["imageSpec"]["Config"]["Cmd"][0], "infinity");
    assert_eq!(
        value["source"]["files"]["nix/worker-pool-anchor-image.nix"]["sha256"],
        hash(&source_file)
    );
    assert!(!repeated.status.success());
    assert_eq!(original, after);
}

#[test]
fn role_platform_and_rootfs_tampering_refuse_without_output() {
    for changed in 0..4 {
        let mut fixture = Fixture::new();
        match changed {
            1 => fixture
                .controller
                .change_config(|v| v["os"] = "windows".into()),
            2 => fixture
                .controller
                .change_config(|v| v["architecture"] = "arm64".into()),
            3 => fixture
                .anchor
                .change_config(|v| v["rootfs"]["diff_ids"] = serde_json::json!([])),
            _ => {}
        }
        let result = fixture.run(changed == 0);
        let output = fixture.output.exists();
        fixture.close();
        assert!(!result.status.success(), "tamper {changed} must refuse");
        assert!(!output);
    }
}

#[test]
fn actual_layer_or_config_changes_cannot_be_sealed_under_old_archive_metadata() {
    for config in [false, true] {
        let fixture = Fixture::new();
        if config {
            let path = fixture.anchor.root.join(&fixture.anchor.config_name);
            let mut raw = fs::read(&path).unwrap();
            raw.extend_from_slice(b" \n");
            assert_eq!(
                serde_json::from_slice::<Value>(&raw).unwrap(),
                fixture.anchor.config
            );
            fs::write(path, raw).unwrap();
        } else {
            fixture.controller.change_valid_layer_payload();
        }
        if config {
            fixture.anchor.pack();
        } else {
            fixture.controller.pack();
        }
        let result = fixture.run(false);
        let output = fixture.output.exists();
        fixture.close();
        assert!(!result.status.success());
        assert!(!output);
    }
}
