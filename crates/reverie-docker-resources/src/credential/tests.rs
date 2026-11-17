use super::*;
use serde_json::{Value, json};

const DIGEST: &str = "7f8803d1db77d0091c86f6e442523fd210760dd4d14cf276ee99bc4972328454";

fn request() -> Value {
    json!({
        "version": 1,
        "purpose": "reverie-boxed-worker-credential-check-v1",
        "issuer": {
            "version": 1,
            "purpose": "reverie-docker-worker-key-v1",
            "instanceId": "10000000-0000-4000-8000-000000000001",
            "key": "42".repeat(32),
        },
        "binding": {
            "employeeId": "10000000-0000-4000-8000-000000000002",
            "sessionId": "10000000-0000-4000-8000-000000000003",
            "sessionGeneration": 11,
            "owner": null,
            "containerId": "a".repeat(64),
            "credentialId": "10000000-0000-4000-8000-000000000004",
        },
        "observedTokenDigest": DIGEST,
    })
}

fn verify_json(request: &Value) -> Result<String> {
    verify(serde_json::to_vec(request).unwrap().as_slice())
}

#[test]
fn deployed_issuer_fixtures_match_and_emit_only_the_binding() {
    // Fixture digests were computed by the deployed Node issuer algorithm.
    for (owner, digest) in [
        (None, DIGEST),
        (
            Some("Zoë ☕ “remote”"),
            "60b72d01ba926d9c6506d5fe08cc1dd376e9d5a2234fe10280a8aa3f75c54cbc",
        ),
    ] {
        let mut input = request();
        input["binding"]["owner"] = json!(owner);
        input["observedTokenDigest"] = json!(digest);
        let output: Value = serde_json::from_str(&verify_json(&input).unwrap()).unwrap();
        assert_eq!(
            output,
            json!({
                "version": 1,
                "purpose": "reverie-boxed-worker-credential-verified-v1",
                "binding": input["binding"],
            })
        );
    }
}

#[test]
fn matching_digest_cannot_be_transferred_to_a_different_scope_or_issuer() {
    for (section, field, wanted) in [
        (
            "binding",
            "employeeId",
            json!("10000000-0000-4000-8000-000000000005"),
        ),
        (
            "binding",
            "sessionId",
            json!("10000000-0000-4000-8000-000000000005"),
        ),
        ("binding", "sessionGeneration", json!(12)),
        ("binding", "containerId", json!("b".repeat(64))),
        ("binding", "owner", json!("another-owner")),
        (
            "binding",
            "credentialId",
            json!("10000000-0000-4000-8000-000000000005"),
        ),
        (
            "issuer",
            "instanceId",
            json!("10000000-0000-4000-8000-000000000005"),
        ),
        ("issuer", "key", json!("43".repeat(32))),
    ] {
        let mut changed = request();
        changed[section][field] = wanted;
        assert!(
            matches!(
                verify_json(&changed),
                Err(Error::Refused("BOXED_WORKER_CREDENTIAL_MISMATCH"))
            ),
            "{field}"
        );
    }
}

#[test]
fn malformed_input_is_refused_without_echoing_private_bytes() {
    for (section, field, wanted) in [
        ("binding", "sessionGeneration", json!(0)),
        (
            "binding",
            "sessionGeneration",
            json!(MAX_SAFE_GENERATION + 1),
        ),
        ("binding", "owner", json!("\nunsafe")),
        ("binding", "containerId", json!("A".repeat(64))),
        ("issuer", "key", json!("private-input")),
    ] {
        let mut changed = request();
        changed[section][field] = wanted;
        assert!(matches!(
            verify_json(&changed),
            Err(Error::Refused(INVALID))
        ));
    }
    let mut duplicate = serde_json::to_vec(&request()).unwrap();
    duplicate.pop();
    duplicate.extend_from_slice(b",\"version\":1}");
    assert!(matches!(
        verify(duplicate.as_slice()),
        Err(Error::Refused(INVALID))
    ));
    assert!(matches!(
        verify([b' '; MAX_REQUEST_BYTES + 1].as_slice()),
        Err(Error::Refused(INVALID))
    ));
}
