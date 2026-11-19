//! Closed qualification evidence for the host's offline worker-store command.
mod admission;
pub mod engine;
mod evidence;
pub mod mounts;
mod profiles;
pub use admission::{
    Capacity, CapacityBudget, CohortBinding, PlanFacts, SealedPlan, plan, plan_text,
};
pub use profiles::{InventoryError, ProfileEntry, ProfileInventory};

use crate::legacy_json::decode_ops_private_bytes;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use serde::{Deserialize, de::DeserializeOwned};
use std::{collections::BTreeSet, fmt};

pub use evidence::{EvidenceKind, EvidenceReference, Receipt};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct QualificationError(&'static str);

impl fmt::Display for QualificationError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.0)
    }
}

impl std::error::Error for QualificationError {}
type Result<T> = std::result::Result<T, QualificationError>;

fn require(condition: bool, message: &'static str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(QualificationError(message))
    }
}

fn decode<T: DeserializeOwned>(bytes: &[u8], message: &'static str) -> Result<T> {
    // Keep the legacy strict bytes decoder, including encoding detection and
    // duplicate-key refusal throughout the original object.
    let data = decode_ops_private_bytes(bytes).map_err(|_| QualificationError(message))?;
    serde_json::from_slice(&data.encode_compact()).map_err(|_| QualificationError(message))
}

#[derive(Clone, Copy, Default, Deserialize, Eq, PartialEq)]
enum ValidationScope {
    #[default]
    #[serde(rename = "CURRENT_CODEX_TOOL_SHELL_ONLY")]
    CurrentAgent,
    #[serde(rename = "VALIDATED_OFFLINE_IMAGE_TOOL_SHELL")]
    OfflineImage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    version: u8,
    kind: String,
    image_id: String,
    engine_id: String,
    engine_socket: String,
    validation_container_id: String,
    base_target: String,
    closure_paths: Vec<String>,
    expires_at_epoch: f64,
    cohort: Vec<Cohort>,
    budget: Box<serde_json::value::RawValue>,
    receipts: References,
    #[serde(default)]
    validation_scope: ValidationScope,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cohort {
    employee_id: String,
    session_id: String,
    session_generation: serde_json::Number,
    employee_digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct References {
    #[serde(rename = "D2")]
    d2: EvidenceReference,
    #[serde(rename = "CAN")]
    can: EvidenceReference,
}

impl Target {
    pub fn decode(bytes: &[u8], now: f64) -> Result<Self> {
        let target = Self::decode_qualified(bytes)?;
        target.require_unexpired(now)?;
        Ok(target)
    }

    pub fn require_unexpired(&self, now: f64) -> Result<()> {
        require(
            now.is_finite() && self.expires_at_epoch.is_finite() && self.expires_at_epoch > now,
            "target qualification expired",
        )
    }

    pub fn engine_id(&self) -> &str {
        &self.engine_id
    }
    pub fn engine_socket(&self) -> &std::path::Path {
        std::path::Path::new(&self.engine_socket)
    }
    pub fn image_id(&self) -> &str {
        &self.image_id
    }
    pub fn validation_container_id(&self) -> &str {
        &self.validation_container_id
    }
    pub fn base_target(&self) -> &str {
        &self.base_target
    }
    pub fn needs_isolated_image(&self) -> bool {
        self.validation_scope == ValidationScope::OfflineImage
    }
    pub fn closure_names(&self) -> impl Iterator<Item = &str> {
        self.closure_paths
            .iter()
            .map(|path| &path["/nix/store/".len()..])
    }
    pub fn budget(&self) -> Result<(CapacityBudget, u8)> {
        Ok((
            CapacityBudget::decode(&self.budget)?,
            u8::try_from(self.cohort.len()).expect("closed cohort bound"),
        ))
    }

    /// Structural reader for subsequent observations of the already pinned
    /// target. The receipt commit still verifies the cohort after seed cleanup
    /// even if the deadline for starting a new effect has passed.
    pub fn decode_qualified(bytes: &[u8]) -> Result<Self> {
        let target: Self = decode(bytes, "closed validated target required")?;
        require(
            target.version == 1 && target.kind == "reverie.worker-store-target",
            "closed validated target required",
        )?;
        target.validate_image()?;
        target.validate_cohort()?;
        Ok(target)
    }

    fn validate_image(&self) -> Result<()> {
        require(
            digest(&self.image_id)
                && hexadecimal_id(&self.validation_container_id)
                && store_path(&self.base_target),
            "exact validated image/base required",
        )?;
        require(
            (1..=128).contains(&self.engine_id.chars().count())
                && !self.engine_id.chars().any(|c| c < '\u{20}'),
            "exact validated engine identity required",
        )?;
        require(
            (1..=32768).contains(&self.closure_paths.len())
                && self.closure_paths.windows(2).all(|pair| pair[0] < pair[1])
                && self.closure_paths.iter().all(|path| store_path(path))
                && self.closure_paths.binary_search(&self.base_target).is_ok(),
            "bounded image closure required",
        )
    }

    fn validate_cohort(&self) -> Result<()> {
        require(
            (1..=32).contains(&self.cohort.len()),
            "explicit bounded offline cohort required",
        )?;
        let mut employees = BTreeSet::new();
        let mut sessions = BTreeSet::new();
        for row in &self.cohort {
            require(
                ProfileEmployeeId::parse(&row.employee_id).is_ok()
                    && ProfileSessionId::parse(&row.session_id).is_ok()
                    && row
                        .session_generation
                        .as_u64()
                        .is_some_and(|value| value > 0)
                    && digest(&row.employee_digest),
                "closed current employee cohort required",
            )?;
            require(
                employees.insert(&row.employee_id) && sessions.insert(&row.session_id),
                "duplicate employee/session",
            )?;
        }
        Ok(())
    }

    pub fn evidence(&self) -> [(EvidenceKind, &EvidenceReference); 2] {
        [
            (EvidenceKind::D2, &self.receipts.d2),
            (EvidenceKind::Can, &self.receipts.can),
        ]
    }
}

fn hexadecimal_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(hexadecimal_id)
}

fn store_path(value: &str) -> bool {
    let Some((hash, name)) = value
        .strip_prefix("/nix/store/")
        .and_then(|value| value.split_once('-'))
    else {
        return false;
    };
    hash.len() == 32
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"+._?=-".contains(&byte))
}
