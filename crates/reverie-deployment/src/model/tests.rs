use super::*;

fn image(env: Value) -> Value {
    json!({"Id":"sha256:fixture", "Config":{"Env":env,"Entrypoint":["/entry"],"Cmd":["web"],"Volumes":null}})
}
fn source(env: Value) -> Value {
    json!({"Config":image(env)["Config"],
        "HostConfig":{"Binds":["/source:/target:ro,rslave"],"Memory":8589934592u64,"Init":true},
        "Mounts":[{"Type":"bind","Source":"/source","Destination":"/target","RW":false,"Propagation":"rslave","Mode":"ro,rslave"}]})
}

#[test]
fn legacy_then_native_update_preserves_front_and_mounts() {
    let first = image(json!(["HOME=/home/agent", "REVERIE_NATIVE_FRONT=1"]));
    let old = image(json!(["HOME=/old"]));
    let original = source(json!(["HOME=/actual", "TOKEN=fixture-only"]));
    let (body, _) = create_body(&original, &old, &first).unwrap();
    let mut running = original.clone();
    running["Config"] = body.clone();
    running["Config"]
        .as_object_mut()
        .unwrap()
        .remove("HostConfig");
    running["Config"]
        .as_object_mut()
        .unwrap()
        .remove("NetworkingConfig");
    let next = image(json!(["HOME=/new-default", "REVERIE_NATIVE_FRONT=1"]));
    let (second, _) = create_body(&running, &first, &next).unwrap();
    let env = second["Env"].as_array().unwrap();
    assert!(env.contains(&json!("HOME=/actual")));
    assert!(env.contains(&json!("TOKEN=fixture-only")));
    assert_eq!(
        env.iter()
            .filter(|v| **v == "REVERIE_NATIVE_FRONT=1")
            .count(),
        1
    );
    assert_eq!(body["HostConfig"], second["HostConfig"]);
    assert_eq!(second["Entrypoint"], original["Config"]["Entrypoint"]);
}

#[test]
fn invalid_front_modes_and_internal_overrides_refuse() {
    let old = image(json!([]));
    let valid = image(json!(["REVERIE_NATIVE_FRONT=1"]));
    for env in [
        json!(["REVERIE_NATIVE_FRONT=0"]),
        json!(["REVERIE_NATIVE_FRONT=true"]),
        json!(["REVERIE_NATIVE_FRONT="]),
        json!(["REVERIE_NATIVE_FRONT=1", "REVERIE_NATIVE_FRONT=1"]),
        json!(["REVERIE_FRONT_CHILD=1"]),
        json!(["REVERIE_NATIVE_FRONT_BIN=/untrusted"]),
    ] {
        assert!(
            create_body(&source(env.clone()), &old, &valid).is_err(),
            "source {env}"
        );
        assert!(
            create_body(&source(json!([])), &old, &image(env.clone())).is_err(),
            "candidate {env}"
        );
    }
    assert!(create_body(&source(json!([])), &old, &image(json!([]))).is_err());
}

#[test]
fn rollback_mode_comes_from_original_container_not_candidate_or_request() {
    assert!(!uses_front(&source(json!([]))["Config"]).unwrap());
    assert!(uses_front(&source(json!(["REVERIE_NATIVE_FRONT=1"]))["Config"]).unwrap());
    for env in [
        json!(["REVERIE_NATIVE_FRONT=0"]),
        json!(["REVERIE_NATIVE_FRONT=true"]),
        json!(["REVERIE_NATIVE_FRONT=1", "REVERIE_NATIVE_FRONT=0"]),
    ] {
        assert!(uses_front(&source(env)["Config"]).is_err());
    }
}

fn gpu_entrypoint(hash: char) -> Value {
    json!([
        "/bin/tini",
        "-g",
        "-s",
        "--",
        format!(
            "/nix/store/{}-reverie-container-runtime-0.1.0/bin/reverie-container-runtime",
            hash.to_string().repeat(32)
        ),
        "/usr/local/bin/reverie-start"
    ])
}

fn gpu_images() -> (Value, Value, Value) {
    let env = json!(["REVERIE_NATIVE_FRONT=1", "SELECTED=fixture-only"]);
    let mut original = source(env.clone());
    let mut old = image(env.clone());
    let mut candidate = image(env);
    old["Id"] = json!(format!("sha256:{}", "a".repeat(64)));
    candidate["Id"] = json!(format!("sha256:{}", "b".repeat(64)));
    original["Image"] = old["Id"].clone();
    original["HostConfig"]["DeviceRequests"] = json!([{ "Driver": "cdi", "Count": 0,
        "DeviceIDs": ["nvidia.com/gpu=fixture"], "Capabilities": null, "Options": null }]);
    original["HostConfig"]["GroupAdd"] = json!(["131"]);
    original["Config"]["Entrypoint"] = gpu_entrypoint('a');
    old["Config"]["Entrypoint"] = gpu_entrypoint('a');
    candidate["Config"]["Entrypoint"] = gpu_entrypoint('b');
    (original, old, candidate)
}

#[test]
fn gpu_image_refreshes_only_its_original_immutable_runtime_entrypoint() {
    let (original, old, candidate) = gpu_images();
    let (body, _) = create_body(&original, &old, &candidate).unwrap();
    assert_eq!(body["Entrypoint"], candidate["Config"]["Entrypoint"]);
    assert_eq!(body["Cmd"], original["Config"]["Cmd"]);
    assert_eq!(
        body["HostConfig"]["Memory"],
        original["HostConfig"]["Memory"]
    );
    assert_eq!(
        body["HostConfig"]["DeviceRequests"],
        original["HostConfig"]["DeviceRequests"]
    );
    assert_eq!(
        body["HostConfig"]["GroupAdd"],
        original["HostConfig"]["GroupAdd"]
    );
    assert_eq!(body["Env"], original["Config"]["Env"]);
}

#[test]
fn gpu_runtime_refresh_never_admits_arbitrary_commands_or_unrelated_images() {
    let (original, old, candidate) = gpu_images();
    let mut foreign_old = old.clone();
    foreign_old["Config"]["Entrypoint"] = gpu_entrypoint('c');
    assert!(create_body(&original, &foreign_old, &candidate).is_err());
    foreign_old = old.clone();
    foreign_old["Id"] = json!(format!("sha256:{}", "c".repeat(64)));
    assert!(create_body(&original, &foreign_old, &candidate).is_err());
    let mut same_id = candidate.clone();
    same_id["Id"] = old["Id"].clone();
    assert!(create_body(&original, &old, &same_id).is_err());
    for index in [0, 1, 2, 3, 5] {
        let mut changed = candidate.clone();
        changed["Config"]["Entrypoint"][index] = json!("unexpected");
        assert!(create_body(&original, &old, &changed).is_err());
    }
    for path in [
        "/opt/reverie-container-runtime/bin/reverie-container-runtime".to_owned(),
        format!(
            "/nix/store/{}-other-0.1.0/bin/reverie-container-runtime",
            "b".repeat(32)
        ),
        format!(
            "/nix/store/{}-reverie-container-runtime-9.0.0/bin/reverie-container-runtime",
            "b".repeat(32)
        ),
        format!(
            "/nix/store/{}-reverie-container-runtime-0.1.0/bin/other",
            "b".repeat(32)
        ),
        format!(
            "/nix/store/{}-reverie-container-runtime-0.1.0/bin/reverie-container-runtime\n",
            "b".repeat(32)
        ),
        format!(
            "/nix/store/{}-reverie-container-runtime-0.1.0/bin/reverie-container-runtime",
            "e".repeat(32)
        ),
        format!(
            "/nix/store/{}-reverie-container-runtime-00.1.0/bin/reverie-container-runtime",
            "b".repeat(32)
        ),
        format!(
            "/nix/store/{}-reverie-container-runtime-0.1.0-extra/bin/reverie-container-runtime",
            "b".repeat(32)
        ),
    ] {
        let mut changed = candidate.clone();
        changed["Config"]["Entrypoint"][4] = json!(path);
        assert!(create_body(&original, &old, &changed).is_err());
    }
    let mut changed = candidate.clone();
    changed["Config"]["Entrypoint"]
        .as_array_mut()
        .unwrap()
        .push(json!("extra"));
    assert!(create_body(&original, &old, &changed).is_err());
    changed = candidate;
    changed["Config"]["Cmd"] = json!(["other"]);
    assert!(create_body(&original, &old, &changed).is_err());
}
