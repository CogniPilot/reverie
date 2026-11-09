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
