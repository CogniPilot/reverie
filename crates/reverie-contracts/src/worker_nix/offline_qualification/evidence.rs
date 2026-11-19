mod report;

use super::{QualificationError, Result, Target, ValidationScope, decode, digest, require};
use reverie_core::ids::ProfileEmployeeId;
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub enum EvidenceKind {
    D2,
    #[serde(rename = "CAN")]
    Can,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceReference {
    path: PathBuf,
    digest: String,
}

impl EvidenceReference {
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    pub fn verify(&self, bytes: &[u8], message: &'static str) -> Result<()> {
        require(
            digest(&self.digest) && format!("sha256:{:x}", Sha256::digest(bytes)) == self.digest,
            message,
        )
    }

    fn from_fields(data: &Map<String, Value>, path: &str, hash: &str) -> Result<Self> {
        let digest = text(data, hash)?;
        require(super::digest(digest), "pinned validation evidence required")?;
        Ok(Self {
            path: PathBuf::from(text(data, path)?),
            digest: digest.to_owned(),
        })
    }
}

#[derive(Deserialize)]
struct Envelope {
    version: u8,
    kind: EvidenceKind,
    data: Map<String, Value>,
}

enum Proof {
    D2 { jobs: u64 },
    Can { probe: EvidenceReference },
}

pub struct Receipt {
    employee: Option<ProfileEmployeeId>,
    report: EvidenceReference,
    proof: Proof,
}

impl Receipt {
    pub fn decode(bytes: &[u8], kind: EvidenceKind, target: &Target) -> Result<Self> {
        let envelope: Envelope = decode(bytes, "actual validation container binding required")?;
        let data = &envelope.data;
        require(
            envelope.version == 1
                && envelope.kind == kind
                && text(data, "containerId")? == target.validation_container_id,
            "actual validation container binding required",
        )?;
        require(
            data.get("version").and_then(Value::as_u64) == Some(1),
            "closed canonical validation data required",
        )?;
        check_fields(data, kind, target.validation_scope)?;
        let employee = bind(data, kind, target)?;
        let proof = proof(data, kind)?;
        Ok(Self {
            employee,
            report: EvidenceReference::from_fields(data, "rawEvidencePath", "rawEvidenceDigest")?,
            proof,
        })
    }

    pub fn match_employee(&self, other: &Self) -> Result<()> {
        require(
            self.employee == other.employee,
            "validation employee differs between receipts",
        )
    }
    pub fn report(&self) -> &EvidenceReference {
        &self.report
    }

    pub fn verify_report(&self, bytes: &[u8]) -> Result<()> {
        self.report
            .verify(bytes, "raw validation evidence changed")?;
        let text = std::str::from_utf8(bytes)
            .map_err(|_| QualificationError("invalid UTF-8 validation evidence"))?;
        match self.proof {
            Proof::D2 { jobs } => require(report::d2(text, jobs), "target D2 did not pass"),
            Proof::Can { .. } => require(report::can(text), "target own-shell CAN did not pass"),
        }
    }

    pub fn probe(&self) -> Option<&EvidenceReference> {
        match &self.proof {
            Proof::D2 { .. } => None,
            Proof::Can { probe } => Some(probe),
        }
    }
}

fn check_fields(
    data: &Map<String, Value>,
    kind: EvidenceKind,
    scope: ValidationScope,
) -> Result<()> {
    let scope_fields: &[_] = match (scope, kind) {
        (ValidationScope::OfflineImage, _) => &["imageId", "scope"],
        (ValidationScope::CurrentAgent, EvidenceKind::D2) => &["employeeId"],
        (ValidationScope::CurrentAgent, EvidenceKind::Can) => {
            &["employeeId", "ownToolShell", "scope"]
        }
    };
    let proof_fields: &[_] = match kind {
        EvidenceKind::D2 => &["jobs"],
        EvidenceKind::Can => &["probePath", "probeDigest"],
    };
    let shared = [
        "version",
        "containerId",
        "rawEvidencePath",
        "rawEvidenceDigest",
    ];
    require(
        data.len() == shared.len() + scope_fields.len() + proof_fields.len()
            && shared
                .iter()
                .chain(scope_fields)
                .chain(proof_fields)
                .all(|key| data.contains_key(*key)),
        "closed canonical validation data required",
    )
}

fn bind(
    data: &Map<String, Value>,
    kind: EvidenceKind,
    target: &Target,
) -> Result<Option<ProfileEmployeeId>> {
    if target.validation_scope == ValidationScope::OfflineImage {
        require(
            text(data, "imageId")? == target.image_id
                && text(data, "scope")? == "OFFLINE_IMAGE_TOOL_SHELL",
            "offline image evidence must bind its exact image/scope",
        )?;
        return Ok(None);
    }
    let employee = ProfileEmployeeId::parse(text(data, "employeeId")?)
        .map_err(|_| QualificationError("exact validation employee required"))?;
    if kind == EvidenceKind::Can {
        require(
            data.get("ownToolShell") == Some(&Value::Bool(true))
                && text(data, "scope")? == "CURRENT_CODEX_TOOL_SHELL_ONLY",
            "target own-shell CAN did not pass",
        )?;
    }
    Ok(Some(employee))
}

fn proof(data: &Map<String, Value>, kind: EvidenceKind) -> Result<Proof> {
    match kind {
        EvidenceKind::D2 => {
            let jobs = data
                .get("jobs")
                .and_then(Value::as_u64)
                .filter(|jobs| *jobs > 0)
                .ok_or(QualificationError("target D2 did not pass"))?;
            Ok(Proof::D2 { jobs })
        }
        EvidenceKind::Can => Ok(Proof::Can {
            probe: EvidenceReference::from_fields(data, "probePath", "probeDigest")?,
        }),
    }
}

fn text<'a>(value: &'a Map<String, Value>, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or(QualificationError(
            "closed canonical validation data required",
        ))
}
