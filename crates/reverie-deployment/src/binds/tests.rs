use super::*;

fn source() -> Value {
    json!({"HostConfig":{"Binds":["/source:/target:ro,rslave"],"Mounts":null,"Memory":8589934592u64,"Init":true},
        "Mounts":[{"Type":"bind","Source":"/source","Destination":"/target","RW":false,"Propagation":"rslave","Mode":"ro,rslave"}]})
}
#[test]
fn no_create_projection_preserves_other_host_fields_and_effective_grants() {
    let old = source();
    let host = project(&old).unwrap();
    assert!(host.get("Binds").is_none());
    assert_eq!(host["Memory"], old["HostConfig"]["Memory"]);
    assert_eq!(host["Init"], true);
    assert_eq!(host["Mounts"][0]["BindOptions"]["CreateMountpoint"], false);
    equivalent(&host, &host).unwrap();
    let mut created = old["Mounts"].clone();
    created[0]["Mode"] = json!("");
    same_grants(&created, &old["Mounts"]).unwrap();
    created[0]["RW"] = json!(true);
    assert!(same_grants(&created, &old["Mounts"]).is_err());
}
#[test]
fn preserves_structured_recursive_flags_and_refuses_widening() {
    let mut old = source();
    old["HostConfig"]["Binds"] = Value::Null;
    old["HostConfig"]["Mounts"] = json!([{"Type":"bind","Source":"/source","Target":"/target","ReadOnly":true,
        "BindOptions":{"Propagation":"rslave","ReadOnlyForceRecursive":true,"NonRecursive":false}}]);
    let host = project(&old).unwrap();
    assert_eq!(
        host["Mounts"][0]["BindOptions"]["ReadOnlyForceRecursive"],
        true
    );
    let mut changed = host.clone();
    changed["Mounts"][0]["BindOptions"]["ReadOnlyForceRecursive"] = json!(false);
    assert!(equivalent(&changed, &host).is_err());
    changed = host.clone();
    changed["Memory"] = json!(1);
    assert!(equivalent(&changed, &host).is_err());
    old["HostConfig"]["Mounts"][0]["BindOptions"]["CreateMountpoint"] = json!(true);
    assert!(project(&old).is_err());
}
#[test]
fn refuses_ambiguous_unresolved_and_unsupported_bind_options() {
    for bind in [
        "/source:/target:ro,rw",
        "/source:/target:ro,z",
        "/source:/target::ro,rslave",
        "/elsewhere:/target:ro",
    ] {
        let mut old = source();
        old["HostConfig"]["Binds"] = json!([bind]);
        assert!(project(&old).is_err(), "{bind}");
    }
    let mut old = source();
    old["HostConfig"]["Binds"]
        .as_array_mut()
        .unwrap()
        .push(json!("/source:/target:ro,rslave"));
    assert!(project(&old).is_err());
    old = source();
    let repeated = old["Mounts"][0].clone();
    old["Mounts"].as_array_mut().unwrap().push(repeated);
    assert!(project(&old).is_err());
}
#[test]
fn docker_omitted_false_defaults_compare_but_true_create_never_does() {
    let mut old = source();
    old["HostConfig"]["Binds"] = json!(["/source:/target:ro"]);
    old["Mounts"][0]["Propagation"] = json!("rprivate");
    let host = project(&old).unwrap();
    let mut omitted = host.clone();
    omitted["Mounts"][0]["BindOptions"] = json!({});
    equivalent(&omitted, &host).unwrap();
    omitted["Mounts"][0]["BindOptions"]["CreateMountpoint"] = json!(true);
    assert!(equivalent(&omitted, &host).is_err());
    omitted["Mounts"][0]["BindOptions"]["CreateMountpoint"] = json!(false);
    omitted["Mounts"][0]["BindOptions"]["Propagation"] = json!(42);
    assert!(equivalent(&omitted, &host).is_err());
}

#[test]
fn docker_oom_unset_is_false_but_disabled_killer_stays_distinct() {
    let mut old = source();
    old["HostConfig"]["OomKillDisable"] = Value::Null;
    let host = project(&old).unwrap();
    assert!(
        host["OomKillDisable"].is_null(),
        "projection preserves original request"
    );
    let mut created = host.clone();
    created["OomKillDisable"] = json!(false);
    equivalent(&created, &host).unwrap();
    created.as_object_mut().unwrap().remove("OomKillDisable");
    equivalent(&created, &host).unwrap();
    created["OomKillDisable"] = json!(true);
    assert!(equivalent(&created, &host).is_err());
    let mut preserved = host.clone();
    preserved["OomKillDisable"] = json!(true);
    equivalent(&created, &preserved).unwrap();
    created["OomKillDisable"] = json!(false);
    assert!(equivalent(&created, &preserved).is_err());
}
