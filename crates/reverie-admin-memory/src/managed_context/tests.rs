use super::*;
use nix::unistd::mkdtemp;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, symlink},
};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(mkdtemp(&env::temp_dir().join("managed-context-XXXXXX")).unwrap())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn issued() -> Value {
    json!({
        "employeeId": "fixture", "sessionId": "synthetic-session", "sessionGeneration": 2,
        "generatedAt": 3, "digest": format!("sha256:{}", "a".repeat(64)),
        "context": "context é 🧪", "sections": [
            {"id": "core-beliefs", "status": "configured", "text": "context é 🧪"},
        ],
    })
}

#[test]
fn strict_bindings_refuse_another_session_and_malformed_sections() {
    let valid: Issued = serde_json::from_value(issued()).unwrap();
    assert!(valid.validate("synthetic-session").is_ok());
    assert!(valid.validate("different-session").is_err());
    for (key, value) in [
        ("sessionGeneration", json!(true)),
        ("generatedAt", json!(-1)),
        ("digest", json!("bad")),
        ("runtimeBinding", json!("bad")),
        (
            "sections",
            json!([{"id": "core-beliefs", "status": "other", "text": "x"}]),
        ),
    ] {
        let mut input = issued();
        input[key] = value;
        assert!(serde_json::from_value::<Issued>(input).is_err(), "{key}");
    }
    let mut invalid = issued();
    invalid["sections"][0]["id"] = json!("Core");
    let invalid: Issued = serde_json::from_value(invalid).unwrap();
    assert!(invalid.validate("synthetic-session").is_err());
}

#[test]
fn only_a_complete_unicode_snapshot_is_receiptable() {
    let mut input = issued();
    input["context"] = json!("🧪".repeat(200));
    let signed: Issued = serde_json::from_value(input).unwrap();
    let exact = Snapshot::new(Some(&signed), 200);
    assert_eq!(exact.text, signed.context);
    assert!(exact.pending(Stage::Startup).is_some());
    let partial = Snapshot::new(Some(&signed), 80);
    assert_eq!(partial.text.chars().count(), 80);
    assert!(partial.text.ends_with(TRUNCATED));
    assert!(partial.pending(Stage::Startup).is_none());
    assert!(Snapshot::new(None, 80).pending(Stage::Startup).is_none());
}

#[test]
fn private_manifest_contains_hashes_and_refuses_symlink_ancestry() {
    let fixture = Fixture::new();
    let state = fixture.0.join("state.json");
    let issued: Issued = serde_json::from_value(issued()).unwrap();
    let snapshot = Snapshot::new(Some(&issued), 200);
    manifest::publish(&state, "synthetic-session", Stage::Startup, &snapshot).unwrap();
    let path = fixture.0.join("managed-context.json");
    let text = fs::read_to_string(&path).unwrap();
    assert!(!text.contains(&issued.context));
    let record: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        record["includedTextSha256"],
        format!("{:x}", Sha256::digest(issued.context.as_bytes()))
    );
    assert_eq!(
        record["sections"][0]["textSha256"],
        record["includedTextSha256"]
    );
    assert_eq!(record["includedChars"], issued.context.chars().count());
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    let alias = fixture.0.join("alias");
    symlink(&fixture.0, &alias).unwrap();
    assert!(
        manifest::publish(
            &alias.join("state.json"),
            "synthetic-session",
            Stage::ModelRequest,
            &snapshot
        )
        .is_err()
    );
    assert_eq!(fs::read_to_string(path).unwrap(), text);
}
