//! A decoder result is DATA only, never controller, origin or installation authority.
use super::*;
use sha2::{Digest, Sha256};

const PURPOSE: &str = "reverie-controller-birth-check-v1";

/// A fixed decoder's acknowledgement for exactly the supplied encoded birth.
/// Consumers must separately authenticate the executable and selected image.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ControllerBirthCheck {
    version: u8,
    purpose: String,
    birth_sha256: String,
    birth_version: u8,
    retained_anchor: bool,
    member_revision: Option<u64>,
}
impl ControllerBirthCheck {
    /// Uses the production service decoder; it never reads a host path or kernel fact.
    pub fn from_birth(raw: &[u8]) -> Result<Self, PoolPolicyError> {
        let birth = ControllerServiceBirth::decode(raw)?;
        Ok(Self {
            version: 1,
            purpose: PURPOSE.into(),
            birth_sha256: format!("{:x}", Sha256::digest(raw)),
            birth_version: if birth.restored() { 3 } else { 2 },
            retained_anchor: birth.retained_anchor().is_some(),
            member_revision: birth
                .member_snapshot()
                .map(CommittedMemberSnapshot::revision),
        })
    }

    pub fn encode(&self) -> Result<Vec<u8>, PoolPolicyError> {
        serde_json::to_vec(self).map_err(|_| PoolPolicyError)
    }

    /// Refuse malformed, duplicate-key, stale, downgraded or different-input replies.
    pub fn verify_reply(raw: &[u8], birth: &[u8]) -> Result<Self, PoolPolicyError> {
        if raw.is_empty() || raw.len() > 4096 {
            return Err(PoolPolicyError);
        }
        crate::worker_config::decode(raw).map_err(|_| PoolPolicyError)?;
        let check: Self = serde_json::from_slice(raw).map_err(|_| PoolPolicyError)?;
        (check == Self::from_birth(birth)?)
            .then_some(check)
            .ok_or(PoolPolicyError)
    }
}
