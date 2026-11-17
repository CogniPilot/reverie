//! Read-only ABI discovery before a plan switch may stop its source.
#![forbid(unsafe_code)]
use crate::install::{Failure, Result};
use std::{ffi::OsString, io::Write};
pub(super) const RECEIPT_FIELDS: &[&str] = &[
    "version",
    "purpose",
    "operationId",
    "sessionId",
    "containerId",
    "projectionDigest",
    "accountId",
    "provider",
    "contextInputDigest",
    "readMode",
    "installedAuthDigest",
    "observedAuthDigest",
    "tokenDigest",
    "contextDigest",
    "observedContextDigest",
    "homeDev",
    "homeIno",
    "configDev",
    "configIno",
];
pub(super) fn arguments(raw: &[OsString]) -> Option<Result<String>> {
    if raw.first().is_none_or(|v| v != "worker-client")
        || raw.get(1).is_none_or(|v| v != "plan-protocol")
    {
        return None;
    }
    Some(match raw {
        [_, _, flag, digest] if flag == "--expected-digest" => digest
            .to_str()
            .filter(|value| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
            })
            .map(str::to_owned)
            .ok_or_else(|| Failure::refused("protocol-arguments")),
        _ => Err(Failure::refused("protocol-arguments")),
    })
}
fn description() -> Result<Vec<u8>> {
    serde_json::to_vec(&serde_json::json!({
        "version": 1, "purpose": "reverie-plan-protocol-v1",
        "protocol": 1, "receiptFields": RECEIPT_FIELDS,
    }))
    .map_err(|e| Failure::new("protocol-json", e))
}
pub(super) fn run(digest: String) -> Result<()> {
    // The fixed capsule verifier earns the actual protected manifest/entry.
    // No HOME, account, token, container, provider or filesystem write is used.
    crate::install::qualify(&digest)?;
    let mut output = std::io::stdout().lock();
    output
        .write_all(&description()?)
        .and_then(|()| output.write_all(b"\n"))
        .and_then(|()| output.flush())
        .map_err(|e| Failure::new("protocol-write", e))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }
    #[test]
    fn exact_readonly_role_accepts_only_a_manifest_digest() {
        let valid = args(&[
            "worker-client",
            "plan-protocol",
            "--expected-digest",
            &"a".repeat(64),
        ]);
        assert_eq!(arguments(&valid).unwrap().unwrap(), "a".repeat(64));
        for input in [
            args(&["worker-client", "plan-protocol"]),
            args(&[
                "worker-client",
                "plan-protocol",
                "--expected-digest",
                &"A".repeat(64),
            ]),
            args(&[
                "worker-client",
                "plan-protocol",
                "--expected-digest",
                "/tmp/entry",
            ]),
            [valid.clone(), args(&["--home=/elsewhere"])].concat(),
        ] {
            assert!(arguments(&input).unwrap().is_err());
        }
        assert!(arguments(&args(&["worker-client", "plan-status"])).is_none());
    }
    #[test]
    fn protocol_description_is_bounded_and_contains_no_runtime_authority() {
        let bytes = description().unwrap();
        assert!(bytes.len() < 1024);
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["purpose"], "reverie-plan-protocol-v1");
        assert_eq!(value["protocol"], 1);
        assert_eq!(value["receiptFields"].as_array().unwrap().len(), 19);
        assert_eq!(value.as_object().unwrap().len(), 4);
    }
}
