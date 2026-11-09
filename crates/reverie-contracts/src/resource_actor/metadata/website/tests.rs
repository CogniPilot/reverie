use super::*;
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};

fn item() -> Json {
    json!({
        "Id":"a".repeat(64),"Image":format!("sha256:{}","b".repeat(64)),
        "State":{"Running":true,"Pid":4242},
        "Config":{"User":"1000:100","Env":["PATH=/bin"],"future":{"kept":1.0}},
        "HostConfig":{"OomKillDisable":false,"Memory":123,"ReadonlyRootfs":true,
            "Privileged":false,"PidMode":"","CapDrop":["ALL"],"CapAdd":null,
            "SecurityOpt":["no-new-privileges:true"],"future":{"kept":-0.0}},
        "Mounts":[{"Destination":"/z","Source":"/source","RW":true,"future":[1,2]},
            {"Destination":"/a","Source":"/other","RW":false}],
        "otherTopLevel":"not discarded by native caller"
    })
}
fn data(item: &Json) -> EngineMetadata {
    EngineMetadata::decode(&serde_json::to_vec(item).unwrap()).unwrap()
}
fn selection(item: &Json) -> WebsiteSelection {
    let metadata = data(item);
    let value = &metadata.0;
    let program = "/nix/store/synthetic-fixed/bin/node";
    let selected = json!({
        "containerId":item["Id"],"imageId":item["Image"],
        "configDigest":digest(required(value,"Config").unwrap()).unwrap().as_str(),
        "hostConfigDigest":digest(&host_config(required(value,"HostConfig").unwrap()).unwrap()).unwrap().as_str(),
        "mountsDigest":digest(&mounts::normalize(required(value,"Mounts").unwrap()).unwrap()).unwrap().as_str(),
        "initPid":null,"initStart":null,"uid":1000,"gid":100,
        "bootstrap":{"executable":program,"argv":[program]},
        "node":{"executable":program,"argv":[program]},
        "codeFiles":{program:{"sha256":"c".repeat(64),"bytes":1}}
    });
    WebsiteSelection::decode(
        &legacy_json::decode_utf8(&serde_json::to_vec(&selected).unwrap()).unwrap(),
    )
    .ok()
    .unwrap()
}
fn code(item: &Json, selected: &WebsiteSelection) -> Option<&'static str> {
    data(item)
        .qualify_website(selected)
        .err()
        .map(|error| error.code())
}
#[test]
fn complete_selected_metadata_yields_only_declared_pid_data() {
    let original = item();
    let selected = selection(&original);
    assert_eq!(
        data(&original)
            .qualify_website(&selected)
            .unwrap()
            .pid()
            .as_str(),
        "4242"
    );
    let mut reordered = original;
    reordered["Mounts"].as_array_mut().unwrap().reverse();
    reordered["HostConfig"]["OomKillDisable"] = Json::Null;
    assert!(data(&reordered).qualify_website(&selected).is_ok());
}
#[test]
fn exact_identity_running_integer_pid_and_user_are_required() {
    let original = item();
    let selected = selection(&original);
    for (name, bad) in [("Id", json!("d".repeat(64))), ("Image", json!("bad"))] {
        let mut changed = original.clone();
        changed[name] = bad;
        assert_eq!(code(&changed, &selected), Some(FULL_SPEC));
    }
    for value in [json!(false), json!(1), json!("true")] {
        let mut changed = original.clone();
        changed["State"]["Running"] = value;
        assert_eq!(code(&changed, &selected), Some(FULL_SPEC));
    }
    for value in [
        json!(true),
        json!(1),
        json!(0),
        json!(-1),
        json!(4242.0),
        json!("4242"),
    ] {
        let mut changed = original.clone();
        changed["State"]["Pid"] = value;
        assert_eq!(code(&changed, &selected), Some(FULL_SPEC));
    }
    let mut changed = original;
    changed["Config"]["User"] = json!("1000");
    assert_eq!(code(&changed, &selected), Some(FULL_SPEC));
}
#[test]
fn unknown_fields_and_floating_types_remain_in_every_selected_digest() {
    let original = item();
    let selected = selection(&original);
    for section in ["Config", "HostConfig"] {
        let mut changed = original.clone();
        changed[section]["future"]["added"] = json!(true);
        assert_eq!(code(&changed, &selected), Some(FULL_SPEC));
    }
    let mut changed = original.clone();
    changed["Mounts"][0]["future"] = json!([1, 3]);
    assert_eq!(code(&changed, &selected), Some(FULL_SPEC));
    let mut changed = original;
    changed["Config"]["future"]["kept"] = json!(1);
    assert_eq!(code(&changed, &selected), Some(FULL_SPEC));
}
#[test]
fn only_exact_null_or_false_normalizes_oom_and_config_comparison_stays_first() {
    let original = item();
    let selected = selection(&original);
    for bad in [json!(true), json!(0), json!(1), json!("false")] {
        let mut changed = original.clone();
        changed["HostConfig"]["OomKillDisable"] = bad;
        assert_eq!(
            code(&changed, &selected),
            Some("OOM_KILLER_MUST_REMAIN_ENABLED")
        );
        changed["Config"]["future"]["kept"] = json!(2);
        assert_eq!(code(&changed, &selected), Some(FULL_SPEC));
    }
    let mut changed = original;
    changed["HostConfig"]
        .as_object_mut()
        .unwrap()
        .remove("OomKillDisable");
    assert_eq!(
        code(&changed, &selected),
        Some("OOM_KILLER_MUST_REMAIN_ENABLED")
    );
}
#[test]
fn security_refuses_even_when_changed_metadata_digests_are_selected() {
    for (field, bad) in [
        ("ReadonlyRootfs", json!(false)),
        ("ReadonlyRootfs", json!(1)),
        ("Privileged", json!(true)),
        ("Privileged", json!(0)),
        ("CapDrop", json!([])),
        ("CapAdd", json!(["SYS_ADMIN"])),
        ("CapAdd", json!(false)),
        ("PidMode", json!("host")),
        ("SecurityOpt", json!([])),
    ] {
        let mut changed = item();
        changed["HostConfig"][field] = bad;
        let selected = selection(&changed);
        assert_eq!(
            code(&changed, &selected),
            Some("PROTECTED_WEBSITE_NAMESPACE_REQUIRED")
        );
    }
    for good in [Json::Null, json!([])] {
        let mut changed = item();
        changed["HostConfig"]["CapAdd"] = good;
        assert!(data(&changed).qualify_website(&selection(&changed)).is_ok());
    }
}
#[test]
fn loader_environment_policy_preserves_exact_original_names_and_shapes() {
    for denied in [
        "NODE_OPTIONS",
        "NODE_PATH=x",
        "PYTHONPATH=x",
        "PYTHONHOME=x",
        "GCONV_PATH=x",
        "OPENSSL_CONF=x",
        "OPENSSL_MODULES=x",
        "LD_FAKE",
    ] {
        let mut changed = item();
        changed["Config"]["Env"] = json!([denied]);
        assert_eq!(
            code(&changed, &selection(&changed)),
            Some("BACKEND_LOADER_ENV_REFUSED")
        );
    }
    for invalid in [Json::Null, json!({}), json!([1]), json!(vec!["X"; 257])] {
        let mut changed = item();
        changed["Config"]["Env"] = invalid;
        assert_eq!(
            code(&changed, &selection(&changed)),
            Some("FIXED_BACKEND_ENV_REQUIRED")
        );
    }
    let mut changed = item();
    changed["Config"]["Env"] = json!(["NODE_OPTIONS_EXTRA=x", "ld_fake=x", "X=LD_FAKE"]);
    assert!(data(&changed).qualify_website(&selection(&changed)).is_ok());
}
#[test]
fn normalized_mounts_keep_unknown_fields_but_refuse_aliases_and_duplicates() {
    let original = item();
    let selected = selection(&original);
    for destination in ["relative", "/a/../b", "/a/", "/a/./b", "///a"] {
        let mut changed = original.clone();
        changed["Mounts"][0]["Destination"] = json!(destination);
        assert_eq!(code(&changed, &selected), Some("MOUNT_DESTINATIONS"));
    }
    let mut changed = original;
    changed["Mounts"][0]["Destination"] = json!("/a");
    assert_eq!(code(&changed, &selected), Some("MOUNT_DESTINATIONS"));
    for destination in ["/", "/nix", "/nix/store/code"] {
        let mut changed = item();
        changed["Mounts"][0]["Destination"] = json!(destination);
        assert_eq!(
            code(&changed, &selection(&changed)),
            Some("IMMUTABLE_BACKEND_CODE_MASKED")
        );
    }
}
#[test]
fn finite_python_canonical_digest_retains_surrogates_float_spelling_and_large_integers() {
    let raw=br#"{"future":{"text":"\ud800","small":1e-7,"negative":-0.0,"float":1.0,"big":9007199254740993,"\u00e9":"\ud83d\ude00"},"User":"1000:100","Env":["PATH=/bin"]}"#;
    let expected=br#"{"Env":["PATH=/bin"],"User":"1000:100","future":{"big":9007199254740993,"float":1.0,"negative":-0.0,"small":1e-07,"text":"\ud800","\u00e9":"\ud83d\ude00"}}"#;
    let metadata = EngineMetadata::decode(raw).unwrap();
    let expected =
        JournalDigest::parse(&crate::digest::hex(&Sha256::digest(expected).into())).unwrap();
    assert_eq!(digest(&metadata.0).unwrap(), expected);
    for raw in [b"NaN".as_slice(), b"Infinity", b"-Infinity", b"1e999"] {
        let value = EngineMetadata::decode(raw).unwrap();
        assert!(digest(&value.0).is_err());
    }
}
