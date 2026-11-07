use super::*;
use serde_json::{Value as Json, json};
use sha2::Digest;
const NODE: &str = "/nix/store/fixture-node/bin/node";
const CONSOLE: &str = "/nix/store/fixture-console";
const ENTRY: &str = "/nix/store/fixture-console/lib/reverie/dist/index.js";
const CLIENT: &str = "/nix/store/fixture-client/bin/client";
fn provenance() -> Json {
    json!({"version":1,"purpose":"website-image-provenance-v1","archiveConfigSHA256":"a".repeat(64),
        "imageSpec":{"Config":{"User":"1000:100","Cmd":["fixed"],"opaque":true},
            "RootFS":{"Type":"layers","Layers":[format!("sha256:{}","c".repeat(64))]},
            "Architecture":"amd64","Os":"linux","Created":"1970-01-01T00:00:01Z"},
        "console":CONSOLE,"node":{"executable":NODE,"argvPrefix":[NODE,ENTRY]},
        "clientManifest":{"path":"/nix/store/fixture/client.json","sha256":"b".repeat(64)},
        "codeFiles":{NODE:{"sha256":"a".repeat(64),"bytes":10},ENTRY:{"sha256":"b".repeat(64),"bytes":11},CLIENT:{"sha256":"c".repeat(64),"bytes":12}},
        "startupManifest":null})
}
fn decode(value: &Json) -> Result<WebsiteImageProvenance> {
    WebsiteImageProvenance::decode(&serde_json::to_vec(value).unwrap())
}
fn actual(value: &Json) -> Json {
    let mut out = value["imageSpec"].clone();
    out["Id"] = json!(format!("sha256:{}", "a".repeat(64)));
    out
}
fn image(value: &Json) -> EngineMetadata {
    EngineMetadata::decode(&serde_json::to_vec(value).unwrap()).unwrap()
}
#[test]
fn full_image_fields_and_archive_config_id_are_compared_without_minting_an_engine() {
    let raw = provenance();
    let selected = decode(&raw).unwrap();
    let mut current = actual(&raw);
    assert_eq!(
        image(&current).qualify_image(&selected).unwrap(),
        current["Id"].as_str().unwrap()
    );
    current["Config"]["opaque"] = json!(1.0);
    current["Created"] = json!("1970-01-01T01:00:01+01:00");
    image(&current).qualify_image(&selected).unwrap();
    for (name, changed) in [
        ("Config", json!({"User":"1000:100"})),
        ("RootFS", json!({"Type":"layers","Layers":[]})),
        ("Architecture", json!("arm64")),
        ("Os", json!("windows")),
        ("Created", json!("1970-01-01T00:00:02Z")),
        ("Id", json!(format!("sha256:{}", "b".repeat(64)))),
    ] {
        let mut changed_image = current.clone();
        changed_image[name] = changed;
        assert!(
            image(&changed_image).qualify_image(&selected).is_err(),
            "{name}"
        );
    }
}
#[test]
fn distribution_manifest_identity_is_distinct_and_only_supported_matching_descriptor_is_accepted() {
    let raw = provenance();
    let selected = decode(&raw).unwrap();
    let mut current = actual(&raw);
    current["Id"] = json!(format!("sha256:{}", "d".repeat(64)));
    for media in [
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
    ] {
        current["Descriptor"] =
            json!({"digest":current["Id"],"mediaType":media,"opaque":"preserved"});
        image(&current).qualify_image(&selected).unwrap();
    }
    for descriptor in [
        Json::Null,
        json!({}),
        json!(true),
        json!({"digest":current["Id"],"mediaType":"arbitrary"}),
        json!({"digest":format!("sha256:{}","e".repeat(64)),"mediaType":"application/vnd.oci.image.manifest.v1+json"}),
    ] {
        current["Descriptor"] = descriptor;
        assert!(image(&current).qualify_image(&selected).is_err());
    }
}
#[test]
fn aware_creation_uses_python_microseconds_and_refuses_naive_or_invalid_instants() {
    let mut raw = provenance();
    raw["imageSpec"]["Created"] = json!("2026-11-07T23:45:12.1234561Z");
    let selected = decode(&raw).unwrap();
    let mut current = actual(&raw);
    current["Created"] = json!("2026-11-07T18:45:12.1234569-05:00");
    image(&current).qualify_image(&selected).unwrap();
    for bad in [
        "2026-11-07T23:45:12.1234570Z",
        "2026-11-07T23:45:12",
        "2026-11-07T23:59:60Z",
    ] {
        current["Created"] = json!(bad);
        assert!(image(&current).qualify_image(&selected).is_err());
    }
}
#[test]
fn provenance_schema_is_closed_and_nonstartup_program_prefix_is_exact() {
    let original = provenance();
    for (name, value) in [
        ("version", json!(true)),
        ("version", json!(1.0)),
        ("purpose", json!("unregistered")),
        ("ownerApproved", json!(true)),
    ] {
        let mut changed = original.clone();
        changed[name] = value;
        assert!(decode(&changed).is_err());
    }
    let mut changed = original.clone();
    changed["node"]["argvPrefix"] = json!([NODE, "wrong-entry"]);
    assert!(decode(&changed).is_err());
    let raw = serde_json::to_vec(&original).unwrap();
    let mut duplicate = b"{\"version\":1,".to_vec();
    duplicate.extend_from_slice(&raw[1..]);
    assert!(WebsiteImageProvenance::decode(&duplicate).is_err());
    assert!(WebsiteImageProvenance::decode(&vec![b' '; 65537]).is_err());
}
fn installed(raw: &Json) -> Json {
    let digest = "a".repeat(64);
    json!({"version":2,"purpose":PURPOSE,"configurationDigest":digest,
        "engine":{"socket":"/run/fixture.sock","identity":[1,2,1000,100],"id":"fixture"},
        "imageProvenance":{"path":"/nix/store/fixture/provenance.json","sha256":digest},"client":raw["clientManifest"],
        "website":{"containerId":"b".repeat(64),"imageId":format!("sha256:{}","a".repeat(64)),
            "configDigest":digest,"hostConfigDigest":digest,"mountsDigest":digest,"initPid":null,"initStart":null,
            "uid":1000,"gid":100,"bootstrap":{"executable":CLIENT,"argv":[CLIENT]},
            "node":{"executable":NODE,"argv":[NODE,ENTRY,"extra-fixed-argument"]},"codeFiles":raw["codeFiles"]}})
}
#[test]
fn immutable_document_and_native_client_selection_must_match_the_same_complete_program_data() {
    let raw = provenance();
    let selected = decode(&raw).unwrap();
    let client = NativeResourceClientManifest::decode(
        &serde_json::to_vec(&json!({"version":2,
        "purpose":"resource-replacement-native-client-v2","brokerWireVersion":1,
        "executable":CLIENT,"executableSHA256":"c".repeat(64),"argvPrefix":[CLIENT]}))
        .unwrap(),
    )
    .unwrap();
    let document = installed(&raw);
    let parse =
        |value: &Json| InstalledFactsDocument::decode(&serde_json::to_vec(value).unwrap()).unwrap();
    selected
        .require_installation(&parse(&document), &client)
        .unwrap();
    for (section, name, value) in [
        ("client", "sha256", json!("d".repeat(64))),
        (
            "website",
            "node",
            json!({"executable":NODE,"argv":[NODE,"changed-entry"]}),
        ),
        (
            "website",
            "bootstrap",
            json!({"executable":CLIENT,"argv":[CLIENT,"extra"]}),
        ),
        (
            "website",
            "codeFiles",
            json!({NODE:{"sha256":"e".repeat(64),"bytes":10}}),
        ),
    ] {
        let mut changed = document.clone();
        changed[section][name] = value;
        assert!(
            selected
                .require_installation(&parse(&changed), &client)
                .is_err()
        );
    }
}
fn native_client() -> NativeResourceClientManifest {
    NativeResourceClientManifest::decode(
        &serde_json::to_vec(&json!({"version":2,
        "purpose":"resource-replacement-native-client-v2","brokerWireVersion":1,
        "executable":CLIENT,"executableSHA256":"c".repeat(64),"argvPrefix":[CLIENT]}))
        .unwrap(),
    )
    .unwrap()
}
fn startup() -> Json {
    let python = "/nix/store/fixture-python/bin/python";
    json!({"version":1,"purpose":"owner-terminal-website-program-v1",
        "nodeInvocation":NODE,"nodeExecutable":NODE,"nodeWrapper":ENTRY,"applicationEntry":ENTRY,
        "argvPrefix":[NODE,ENTRY],"normalEntrypoint":"/nix/store/fixture-entrypoint",
        "startupPython":{"invocation":"/nix/store/fixture-python-env/bin/python","executable":python,
            "entry":"/nix/store/fixture-bootstrap.py","bootstrapModule":"/nix/store/fixture-module.py",
            "packageInit":"/nix/store/fixture-init.py","argvPrefix":["/nix/store/fixture-python-env/bin/python","-I","/nix/store/fixture-bootstrap.py"]},
        "codeFiles":{NODE:{"sha256":"a".repeat(64),"bytes":10},ENTRY:{"sha256":"b".repeat(64),"bytes":11},
            python:{"sha256":"d".repeat(64),"bytes":12},"/nix/store/fixture-bootstrap.py":{"sha256":"e".repeat(64),"bytes":1},
            "/nix/store/fixture-module.py":{"sha256":"f".repeat(64),"bytes":2},"/nix/store/fixture-init.py":{"sha256":"a".repeat(64),"bytes":3},
            "/nix/store/fixture-entrypoint":{"sha256":"b".repeat(64),"bytes":4}}})
}
fn selected_startup(value: &Json) -> (WebsiteImageProvenance, InstalledFactsDocument, Vec<u8>) {
    let raw = serde_json::to_vec(value).unwrap();
    let mut source = provenance();
    for (name, value) in value["codeFiles"].as_object().unwrap() {
        source["codeFiles"][name] = value.clone();
    }
    source["startupManifest"] = json!({"path":"/nix/store/fixture/startup.json","sha256":format!("{:x}",sha2::Sha256::digest(&raw))});
    let document =
        InstalledFactsDocument::decode(&serde_json::to_vec(&installed(&source)).unwrap()).unwrap();
    (decode(&source).unwrap(), document, raw)
}
#[test]
fn complete_symbolic_startup_graph_requires_exact_bytes_and_preserves_native_alias_obligations() {
    let (selected, document, raw) = selected_startup(&startup());
    let graph = selected
        .program_graph(&document, &native_client(), Some(&raw))
        .unwrap();
    assert!(
        graph
            .invocations()
            .iter()
            .any(|value| matches!(value.kind(), InvocationKind::LegacyPython))
    );
    assert!(
        graph
            .invocations()
            .iter()
            .any(|value| matches!(value.kind(), InvocationKind::ManifestedArgument))
    );
    assert!(
        selected
            .program_graph(&document, &native_client(), None)
            .is_err()
    );
    let mut altered = raw;
    altered.push(b' ');
    assert!(
        selected
            .program_graph(&document, &native_client(), Some(&altered))
            .is_err()
    );
}
#[test]
fn even_rehashed_startup_manifest_cannot_change_node_binding_or_omit_required_code() {
    for (field, value) in [
        ("nodeExecutable", json!(CLIENT)),
        ("applicationEntry", json!("/nix/store/other-entry")),
        ("argvPrefix", json!([NODE, "/nix/store/other-wrapper"])),
    ] {
        let mut source = startup();
        source[field] = value;
        let (selected, document, raw) = selected_startup(&source);
        assert!(
            selected
                .program_graph(&document, &native_client(), Some(&raw))
                .is_err(),
            "{field}"
        );
    }
    let mut source = startup();
    source["codeFiles"]
        .as_object_mut()
        .unwrap()
        .remove("/nix/store/fixture-module.py");
    let (selected, document, raw) = selected_startup(&source);
    assert!(
        selected
            .program_graph(&document, &native_client(), Some(&raw))
            .is_err()
    );
}
