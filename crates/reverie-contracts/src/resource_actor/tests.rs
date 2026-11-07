use super::*;
use serde_json::{Value as Json, json};

fn document() -> Json {
    let sha = "a".repeat(64);
    let program = "/nix/store/synthetic-code/bin/program";
    json!({
        "version":2,"purpose":PURPOSE,"configurationDigest":sha,
        "engine":{"socket":"/run/synthetic-engine.sock","identity":[1,2,1000,100],"id":"synthetic-engine"},
        "imageProvenance":{"path":"/nix/store/synthetic/provenance.json","sha256":sha},
        "client":{"path":"/nix/store/synthetic/client.json","sha256":sha},
        "website":{"containerId":"b".repeat(64),"imageId":format!("sha256:{}","c".repeat(64)),
            "configDigest":sha,"hostConfigDigest":sha,"mountsDigest":sha,
            "initPid":null,"initStart":null,"uid":1000,"gid":100,
            "bootstrap":{"executable":program,"argv":[program]},
            "node":{"executable":program,"argv":[program,"fixed-entry"]},
            "codeFiles":{program:{"sha256":sha,"bytes":16}}}
    })
}
fn decode(value: &Json) -> Result<InstalledFactsDocument> {
    InstalledFactsDocument::decode(&serde_json::to_vec(value).unwrap())
}
#[test]
fn initial_q_hello_preserves_actual_python_dictionary_equality_and_bytes_decoding() {
    for version in ["1", "true", "1.0", "1e0"] {
        let raw = format!("{{\"purpose\":\"{PURPOSE}\",\"version\":{version}}}");
        assert!(decode_initial_hello(raw.as_bytes()).is_ok());
    }
    assert!(decode_initial_hello(br#"{"purpose":"obsolete","purpose":"resource-replacement-v1","version":false,"version":1}"#).is_ok());
    let mut utf16 = vec![0xff, 0xfe];
    for unit in format!("{{\"purpose\":\"{PURPOSE}\",\"version\":1}}").encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    assert!(decode_initial_hello(&utf16).is_ok());
    for raw in [
        b"".as_slice(),
        b"[]",
        br#"{"purpose":"resource-replacement-v1","version":1,"owner":true}"#,
        br#"{"purpose":"resource-replacement-v1","version":NaN}"#,
    ] {
        assert!(decode_initial_hello(raw).is_err());
    }
}
#[test]
fn private_facts_are_closed_data_and_do_not_open_nonexistent_references() {
    let value = decode(&document()).ok().unwrap();
    assert_eq!(value.engine.id, "synthetic-engine");
    assert_eq!(value.engine.identity[2].as_str(), "1000");
    assert!(value.website.initial.is_none());
    assert_eq!(value.website.code.len(), 1);
    assert_eq!(value.website.code[0].bytes, 16);
    assert_eq!(value.website.uid, 1000);
    // These non-existent paths are only DATA. Native admission still needs the
    // actual selected private file, same engine, immutable code and real peer.
    assert!(!value.client.path.codepoints().is_empty());
}
#[test]
fn private_document_rejects_duplicate_fields_wrong_version_and_open_authority_flags() {
    for version in [json!(true), json!(2.0), json!(1)] {
        let mut value = document();
        value["version"] = version;
        assert!(decode(&value).is_err());
    }
    let mut value = document();
    value["ownerApproved"] = json!(true);
    assert!(decode(&value).is_err());
    let raw = serde_json::to_vec(&document()).unwrap();
    let mut duplicate = br#"{"version":2,"#.to_vec();
    duplicate.extend_from_slice(&raw[1..]);
    assert!(InstalledFactsDocument::decode(&duplicate).is_err());
}
#[test]
fn selected_process_pair_code_budget_and_program_arguments_are_checked_without_minting_a_peer() {
    let mut value = document();
    value["website"]["initPid"] = json!(123);
    assert!(decode(&value).is_err());
    value["website"]["initStart"] = json!(456);
    assert!(decode(&value).is_ok());
    value["website"]["node"]["argv"] = json!(["bad\0argument"]);
    assert!(decode(&value).is_err());
    let mut value = document();
    value["engine"]["identity"] = json!([1, 2, 3]);
    assert!(decode(&value).is_err());
    let mut value = document();
    value["website"]["codeFiles"]["/nix/store/synthetic-code/bin/program"]["bytes"] =
        json!(268435457);
    assert!(decode(&value).is_err());
    let mut value = document();
    value["website"]["codeFiles"] =
        json!({"/nix/store/source/../other":{"sha256":"a".repeat(64),"bytes":16}});
    assert!(decode(&value).is_err());
}
