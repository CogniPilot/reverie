use reverie_contracts::lease_policy::{LeaseConfig, peer_artifact_digest, select_company};
use reverie_contracts::worker_config::{config_digest, encode_config};
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::lease_policy::{PeerMachine, static_peer_elf};
use serde::Deserialize;

#[derive(Deserialize)]
struct Corpus {
    options: Vec<OptionCase>,
    projections: Vec<ProjectionCase>,
}
#[derive(Deserialize)]
struct OptionCase {
    name: String,
    raw: String,
    accepted: bool,
    enabled: bool,
}
#[derive(Deserialize)]
struct ProjectionCase {
    name: String,
    raw: String,
    company_hex: String,
    session: String,
    accepted: bool,
    artifact_stub_calls: usize,
    projected: Option<String>,
    config_sha256: Option<String>,
}
fn unhex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
#[test]
fn legacy_validate_option_vectors_match_exact_lexical_data_semantics() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/lease-policy-python-interop.json")).unwrap();
    assert_eq!(corpus.options.len(), 53);
    for case in corpus.options {
        let captured = LeaseConfig::decode(case.raw.as_bytes());
        assert_eq!(captured.is_ok(), case.accepted, "{}", case.name);
        if let Ok(captured) = captured {
            assert_eq!(captured.option().is_some(), case.enabled, "{}", case.name);
        }
    }
}
#[test]
fn actual_python_lease_projection_matches_selected_mount_and_untouched_hash_bytes() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/lease-policy-python-interop.json")).unwrap();
    assert_eq!(corpus.projections.len(), 22);
    for case in corpus.projections {
        let captured = LeaseConfig::decode(case.raw.as_bytes()).unwrap();
        let selection = captured
            .option()
            .map(|option| select_company(&unhex(&case.company_hex), option.employee()))
            .transpose();
        let projected = selection.and_then(|selected| {
            captured.project(
                &ProfileSessionId::parse(&case.session).unwrap(),
                selected.as_ref(),
            )
        });
        assert_eq!(projected.is_ok(), case.accepted, "{}", case.name);
        if let Ok(projected) = projected {
            assert_eq!(
                encode_config(projected.config()),
                case.projected.unwrap().as_bytes(),
                "{} bytes",
                case.name
            );
            assert_eq!(
                config_digest(projected.config()).to_hex(),
                case.config_sha256.unwrap(),
                "{} hash",
                case.name
            );
            assert_eq!(
                usize::from(projected.artifact_required().is_some()),
                case.artifact_stub_calls,
                "{} artifact requirement",
                case.name
            );
        }
    }
}
#[derive(Deserialize)]
struct ElfCorpus {
    cases: Vec<ElfCase>,
}
#[derive(Deserialize)]
struct ElfCase {
    name: String,
    hex: String,
    machine: String,
    accepted: bool,
}
#[test]
fn actual_python_elf_header_checks_match_without_claiming_native_execution() {
    assert_eq!(
        peer_artifact_digest(b"").to_hex(),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    let corpus: ElfCorpus =
        serde_json::from_str(include_str!("fixtures/peer-elf-python-interop.json")).unwrap();
    for case in corpus.cases {
        let machine = match case.machine.as_str() {
            "x86_64" => Some(PeerMachine::X86_64),
            "aarch64" => Some(PeerMachine::Aarch64),
            _ => None,
        };
        assert_eq!(
            machine.is_some_and(|machine| static_peer_elf(&unhex(&case.hex), machine).is_ok()),
            case.accepted,
            "{}",
            case.name
        );
    }
}
#[test]
fn absent_and_null_option_preserve_identity_without_any_registry_input() {
    for raw in [
        r#"{"leaseAcceptance":null,"uid":[],"mounts":null,"payload":-0.0}"#,
        r#"{"payload":1.0}"#,
    ] {
        let before = reverie_contracts::worker_config::decode(raw.as_bytes()).unwrap();
        let projected = LeaseConfig::decode(raw.as_bytes())
            .unwrap()
            .project(
                &ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap(),
                None,
            )
            .unwrap();
        assert_eq!(encode_config(projected.config()), encode_config(&before));
        assert!(projected.artifact_required().is_none());
    }
}
#[test]
fn selected_registry_scope_does_not_add_gpu_generation_owner_or_global_dedup_gates() {
    let employee = ProfileEmployeeId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    let raw=br#"{"employees":[{"id":"00000000-0000-0000-0000-000000000000","sessionId":"00000000-0000-0000-0000-000000000000","owner":[],"sessionGeneration":false},{"id":"opaque"},{"id":"opaque"}],"retired":false,"overflow":1e309}"#;
    assert_eq!(
        select_company(raw, &employee).unwrap().session().as_str(),
        employee.as_str()
    );
    for raw in [
        br#"{"employees":[],"unused":NaN}"#.as_slice(),
        br#"{"employees":[],"unused":Infinity}"#,
        br#"{"employees":[],"unused":-Infinity}"#,
    ] {
        assert!(select_company(raw, &employee).is_err());
    }
}
