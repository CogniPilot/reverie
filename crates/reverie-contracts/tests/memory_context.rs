//! Synthetic installed DATA; no fixture grants a memory read or launches work.
use reverie_contracts::memory_context::{MAX_BYTES, decode, encode};
use reverie_core::{
    PythonText,
    memory::{MemoryScope, ProjectName},
    memory_context::{EmployeeContext, InstalledMemoryContext, ScopeReference, ScopeResource},
    memory_instance::InstanceId,
};
use serde_json::{Value, json};

fn document() -> InstalledMemoryContext {
    InstalledMemoryContext::try_new(
        ScopeReference::parse("configured-existing").unwrap(),
        InstanceId::parse("Existing_Agent").unwrap(),
        EmployeeContext::try_new(
            Some(PythonText::try_new(vec![97, 0xd800]).unwrap()),
            ScopeReference::parse("legacy-employee-17").unwrap(),
            ScopeReference::parse("ses_existing").unwrap(),
            2,
        )
        .unwrap(),
        PythonText::try_new(vec![47, 101, 116, 99, 47, 0xd800, 0xdc00, 0xdcff]).unwrap(),
        vec![
            ScopeResource::new(
                ScopeReference::parse("private-configured").unwrap(),
                MemoryScope::Private,
            ),
            ScopeResource::new(
                ScopeReference::parse("project-configured").unwrap(),
                MemoryScope::Project(ProjectName::parse("kept-project").unwrap()),
            ),
        ],
    )
    .unwrap()
}
fn value() -> Value {
    serde_json::from_slice(&encode(&document()).unwrap()).unwrap()
}
fn refused(value: Value) {
    assert!(decode(&serde_json::to_vec(&value).unwrap()).is_err());
}
#[test]
fn exact_data_roundtrip_preserves_existing_ids_and_codepoint_paths_without_minting_authority() {
    let context = document();
    let raw = encode(&context).unwrap();
    assert_eq!(decode(&raw).unwrap(), context);
    assert_eq!(context.instance().as_str(), "Existing_Agent");
    assert_eq!(
        context.configuration().codepoints(),
        &[47, 101, 116, 99, 47, 0xd800, 0xdc00, 0xdcff]
    );
    assert_eq!(
        context
            .resource_for(&MemoryScope::Private)
            .unwrap()
            .as_str(),
        "private-configured"
    );
    assert!(
        context
            .resource_for(&MemoryScope::Project(ProjectName::parse("other").unwrap()))
            .is_none()
    );
    assert!(raw.is_ascii());
}
#[test]
fn closed_schema_rejects_extra_proof_flags_duplicates_and_ambiguous_scope_maps() {
    for field in [
        "grant",
        "allow",
        "ready",
        "executable",
        "env",
        "policyDigest",
    ] {
        let mut bad = value();
        bad[field] = json!(true);
        refused(bad);
    }
    let mut bad = value();
    bad["employee"]["grantId"] = json!("not-authority");
    refused(bad);
    let raw = String::from_utf8(encode(&document()).unwrap()).unwrap();
    let duplicate = raw.replacen(
        "\"instanceId\":",
        "\"instanceId\":\"other\",\"instanceId\":",
        1,
    );
    assert!(decode(duplicate.as_bytes()).is_err());
    let mut bad = value();
    bad["resources"][1]["resourceId"] = bad["resources"][0]["resourceId"].clone();
    refused(bad);
    let mut bad = value();
    bad["resources"][1]["scope"] = bad["resources"][0]["scope"].clone();
    refused(bad);
    let mut bad = value();
    bad["resources"][0]["scope"]["project"] = json!("hidden");
    refused(bad);
    let mut bad = value();
    bad["resources"][0]["scope"]["project"] = Value::Null;
    refused(bad);
}
#[test]
fn protocol_bounds_and_path_selection_refuse_without_narrowing_standalone_instance_schema() {
    for generation in [json!(0), json!(9007199254740992u64), json!(-1), json!(1.0)] {
        let mut bad = value();
        bad["employee"]["sessionGeneration"] = generation;
        refused(bad);
    }
    for path in [
        json!([]),
        json!([97]),
        json!([47, 0]),
        json!([47, 1114112]),
        json!([47, 1.0]),
    ] {
        let mut bad = value();
        bad["configPathCodepoints"] = path;
        refused(bad);
    }
    for project in ["", "UPPER", "../other"] {
        let mut bad = value();
        bad["resources"][1]["scope"]["project"] = json!(project);
        refused(bad);
    }
    for fields in [json!([]), json!(null)] {
        let mut bad = value();
        bad["resources"] = fields;
        refused(bad);
    }
    assert!(decode(&vec![b' '; MAX_BYTES + 1]).is_err());
}

#[test]
fn fixed_mcp_bootstrap_omits_paths_and_keys_preserving_exact_context_labels() {
    use reverie_contracts::{mcp_bootstrap, memory_context::fingerprint};
    use reverie_core::memory_context::McpOptions;
    let context = document();
    let raw = encode(&context).unwrap();
    let digest = fingerprint(&raw).unwrap();
    let options = McpOptions::default();
    let bytes = mcp_bootstrap::encode(
        "/nix/store/fixed/bin/reverie-memory",
        &options,
        Some((&context, &digest)),
    )
    .unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["schema"], "reverie-installed-mcp-bootstrap-v1");
    assert_eq!(
        value["context"]["officeApiUrl"],
        reverie_core::worker_child::OFFICE_API_URL
    );
    assert_eq!(value["context"]["data"]["instanceId"], "Existing_Agent");
    assert_eq!(
        value["context"]["data"]["employee"]["ownerCodepoints"],
        json!([97, 55296])
    );
    assert_eq!(value["context"]["data"]["fingerprint"], digest.as_str());
    let text = String::from_utf8(bytes).unwrap();
    for absent in ["configPath", "grantId", "password", "ready", "allow\""] {
        assert!(!text.contains(absent), "unexpected {absent}: {text}");
    }
    let empty =
        mcp_bootstrap::encode("/nix/store/fixed/bin/reverie-memory", &options, None).unwrap();
    let empty: Value = serde_json::from_slice(&empty).unwrap();
    assert_eq!(empty["context"]["installed"], false);
    assert!(empty["context"].get("data").is_none());
}
