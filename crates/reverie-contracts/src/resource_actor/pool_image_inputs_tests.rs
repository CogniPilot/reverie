use super::*;
use serde_json::{Value as Json, json};

fn image(entry: &str) -> Json {
    json!({"Config":{"Entrypoint":[entry],"Cmd":["infinity"],"Env":["PATH=/bin"],"User":"0:0","WorkingDir":"/"},
        "RootFS":{"Type":"layers","Layers":[format!("sha256:{}","1".repeat(64))]},
        "Architecture":"amd64","Os":"linux","Created":"1970-01-01T00:00:01Z"})
}
fn document() -> Json {
    let files: serde_json::Map<_, _> = POOL_IMAGE_INPUT_FACTORY_FILES
        .iter()
        .map(|name| {
            (
                (*name).to_owned(),
                json!({"sha256":"f".repeat(64),"bytes":1}),
            )
        })
        .collect();
    let role = |entry: &str, digest: &str| {
        json!({
        "archive":{"path":"/tmp/measured.tar.gz","sha256":"e".repeat(64),"bytes":128},
        "archiveConfigSHA256":digest.repeat(64),"imageSpec":image(entry)})
    };
    json!({"version":1,"purpose":"worker-pool-image-inputs-v1","system":"x86_64-linux",
        "source":{"path":"/tmp/source","files":files},
        "controller":role("/bin/reverie-worker-resource-controller","c"),
        "anchor":role("/bin/sleep","a")})
}
fn decode(value: &Json) -> Result<PoolImageInputsData> {
    PoolImageInputsData::decode(&serde_json::to_vec(value).unwrap())
}
fn observed(value: &Json, digest: &str) -> EngineMetadata {
    let mut value = value.clone();
    value["Id"] = json!(format!("sha256:{}", digest.repeat(64)));
    EngineMetadata::decode(&serde_json::to_vec(&value).unwrap()).unwrap()
}

#[test]
fn closed_two_role_inputs_keep_measured_source_archive_and_platform_data() {
    let selected = decode(&document()).unwrap();
    assert_eq!(selected.system(), "x86_64-linux");
    assert_eq!(selected.factory_files().count(), 7);
    assert_eq!(selected.archive(PoolImageRole::Anchor).bytes, 128);
    assert_eq!(
        selected
            .archive_config_digest(PoolImageRole::Controller)
            .as_str(),
        "c".repeat(64)
    );
    for (pointer, replacement) in [
        ("/version", json!(1.0)),
        ("/system", json!("x86_64-darwin")),
        ("/anchor/imageSpec/Architecture", json!("arm64")),
        ("/controller/imageSpec/Os", json!("windows")),
        ("/anchor/imageSpec/Created", json!("1970-01-01T00:00:01")),
        ("/anchor/imageSpec/RootFS/Layers", json!([])),
        ("/anchor/imageSpec/RootFS/Layers/0", json!("sha256:invalid")),
        ("/anchor/archive/bytes", json!(0)),
        ("/source/path", json!("/tmp/../other")),
    ] {
        let mut value = document();
        *value.pointer_mut(pointer).unwrap() = replacement;
        assert!(decode(&value).is_err(), "{pointer}");
    }
    let mut value = document();
    value["source"]["files"]
        .as_object_mut()
        .unwrap()
        .remove(POOL_IMAGE_INPUT_FACTORY_FILES[0]);
    assert!(decode(&value).is_err());
    let raw = serde_json::to_string(&document()).unwrap();
    let duplicate = raw.replacen("\"version\":1", "\"version\":1,\"version\":1", 1);
    assert!(PoolImageInputsData::decode(duplicate.as_bytes()).is_err());
}

#[test]
fn controller_program_measurement_is_explicit_versioned_and_not_inferred_for_legacy_inputs() {
    let legacy = document();
    assert!(decode(&legacy).unwrap().controller_program().is_none());
    let mut measured = legacy.clone();
    measured["version"] = json!(2);
    measured["purpose"] = json!(POOL_IMAGE_INPUTS_PROGRAM_PURPOSE);
    measured["controller"]["program"] = json!({
        "path":"/nix/store/factory-controller/bin/reverie-worker-resource-controller",
        "sha256":"d".repeat(64),"bytes":4096
    });
    assert_eq!(
        decode(&measured)
            .unwrap()
            .controller_program()
            .unwrap()
            .bytes,
        4096
    );
    let mut absent = measured.clone();
    absent["controller"]
        .as_object_mut()
        .unwrap()
        .remove("program");
    assert!(decode(&absent).is_err());
    for (pointer, replacement) in [
        (
            "/controller/program/path",
            json!("/tmp/controller/bin/reverie-worker-resource-controller"),
        ),
        (
            "/controller/program/path",
            json!("/nix/store/factory-controller/bin/other"),
        ),
        ("/controller/program/sha256", json!("bad")),
        ("/controller/program/bytes", json!(0)),
    ] {
        let mut changed = measured.clone();
        *changed.pointer_mut(pointer).unwrap() = replacement;
        assert!(decode(&changed).is_err(), "{pointer}");
    }
    measured["version"] = json!(1);
    measured["purpose"] = json!(POOL_IMAGE_INPUTS_PURPOSE);
    assert!(
        decode(&measured).is_err(),
        "legacy fields cannot acquire implicit capability"
    );
}

#[test]
fn full_loaded_fields_use_existing_legacy_and_native_descriptor_identity_rules() {
    let value = document();
    let selected = decode(&value).unwrap();
    let anchor = &value["anchor"]["imageSpec"];
    let original = observed(anchor, "a");
    assert!(
        original
            .qualify_pool_image(&selected, PoolImageRole::Anchor)
            .is_ok()
    );
    assert!(
        original
            .qualify_pool_image(&selected, PoolImageRole::Controller)
            .is_err()
    );
    for (pointer, replacement) in [
        ("/Config/User", json!("1000:1000")),
        (
            "/RootFS/Layers/0",
            json!(format!("sha256:{}", "2".repeat(64))),
        ),
        ("/Architecture", json!("arm64")),
        ("/Created", json!("1970-01-01T00:00:02Z")),
    ] {
        let mut altered = anchor.clone();
        *altered.pointer_mut(pointer).unwrap() = replacement;
        assert!(
            observed(&altered, "a")
                .qualify_pool_image(&selected, PoolImageRole::Anchor)
                .is_err()
        );
    }
    assert!(
        observed(anchor, "b")
            .qualify_pool_image(&selected, PoolImageRole::Anchor)
            .is_err()
    );
    let mut native = anchor.clone();
    native["Id"] = json!(format!("sha256:{}", "d".repeat(64)));
    native["Descriptor"] =
        json!({"digest":native["Id"],"mediaType":"application/vnd.oci.image.manifest.v1+json"});
    native["Created"] = json!("1970-01-01T01:00:01+01:00");
    let actual = EngineMetadata::decode(&serde_json::to_vec(&native).unwrap()).unwrap();
    assert_eq!(
        actual
            .qualify_pool_image(&selected, PoolImageRole::Anchor)
            .unwrap(),
        native["Id"].as_str().unwrap()
    );
    native["Descriptor"]["digest"] = json!(format!("sha256:{}", "e".repeat(64)));
    let wrong = EngineMetadata::decode(&serde_json::to_vec(&native).unwrap()).unwrap();
    assert!(
        wrong
            .qualify_pool_image(&selected, PoolImageRole::Anchor)
            .is_err()
    );
}
