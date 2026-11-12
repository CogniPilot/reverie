//! Versioned immutable input for a fresh authenticated controller generation.
//! This data supplies neither installation consent nor predecessor custody.
use super::*;

const PURPOSE: &str = "reverie-docker-worker-controller-v3";

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MemberSnapshot {
    revision: u64,
    overrides: BTreeMap<String, WorkerPoolMemberPolicy>,
}

/// The complete committed sparse overlay, including a positive revision after
/// all edited values have returned to birth defaults.
#[derive(Clone, Eq, PartialEq)]
pub struct CommittedMemberSnapshot(MemberSnapshot);

impl CommittedMemberSnapshot {
    pub fn revision(&self) -> u64 {
        self.0.revision
    }

    pub fn overrides(&self) -> &BTreeMap<String, WorkerPoolMemberPolicy> {
        &self.0.overrides
    }
}

#[derive(Clone, Eq, PartialEq)]
struct Restoration {
    members: Option<CommittedMemberSnapshot>,
    retained_anchor: Option<RetainedPoolAnchor>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RestoredDocument {
    version: u32,
    purpose: String,
    birth: BirthDocument,
    members: Option<MemberSnapshot>,
    retained_anchor: Option<RetainedPoolAnchor>,
}

/// Service birth identity. An original birth preserves the exact v2 bytes.
/// A restored birth binds the new process and its installed provider snapshot.
#[derive(Clone, Eq, PartialEq)]
pub struct ControllerServiceBirth {
    birth: ControllerBirthV2,
    restoration: Option<Restoration>,
}

impl From<ControllerBirthV2> for ControllerServiceBirth {
    fn from(birth: ControllerBirthV2) -> Self {
        Self {
            birth,
            restoration: None,
        }
    }
}

impl ControllerServiceBirth {
    pub fn from_installed_provider(
        birth: ControllerBirthV2,
        provider: &WorkerPoolProvider,
        retained_anchor: Option<RetainedPoolAnchor>,
    ) -> Result<Self, PoolPolicyError> {
        if birth.policy() != provider.policy() {
            return Err(PoolPolicyError);
        }
        let members = (provider.member_revision() > 0).then(|| MemberSnapshot {
            revision: provider.member_revision(),
            overrides: provider.member_overrides().clone(),
        });
        Self::checked_restoration(birth, members, retained_anchor)
    }

    pub fn decode(raw: &[u8]) -> Result<Self, PoolPolicyError> {
        if raw.is_empty() || raw.len() > 65_536 {
            return Err(PoolPolicyError);
        }
        if let Ok(birth) = ControllerBirthV2::decode(raw) {
            return Ok(birth.into());
        }
        // The private provider configuration has already been decoded when
        // produced. Reject duplicate keys anywhere in an incoming v3 birth,
        // including within the sparse employee override map.
        crate::worker_config::decode(raw).map_err(|_| PoolPolicyError)?;
        let document: RestoredDocument =
            serde_json::from_slice(raw).map_err(|_| PoolPolicyError)?;
        if document.version != 3 || document.purpose != PURPOSE {
            return Err(PoolPolicyError);
        }
        let birth = ControllerBirthV2::checked_document(document.birth)?;
        Self::checked_restoration(birth, document.members, document.retained_anchor)
    }

    fn checked_restoration(
        birth: ControllerBirthV2,
        members: Option<MemberSnapshot>,
        retained_anchor: Option<RetainedPoolAnchor>,
    ) -> Result<Self, PoolPolicyError> {
        if let Some(members) = &members {
            if members.revision == 0 {
                return Err(PoolPolicyError);
            }
            super::super::provider::validate_member_overrides(birth.policy(), &members.overrides)?;
        } else if retained_anchor.is_none() {
            return Err(PoolPolicyError);
        }
        Ok(Self {
            birth,
            restoration: Some(Restoration {
                members: members.map(CommittedMemberSnapshot),
                retained_anchor,
            }),
        })
    }

    pub fn encode(&self) -> Result<Vec<u8>, PoolPolicyError> {
        let Some(restoration) = &self.restoration else {
            return self.birth.encode();
        };
        let raw = serde_json::to_vec(&RestoredDocument {
            version: 3,
            purpose: PURPOSE.into(),
            birth: self.birth.document(),
            members: restoration
                .members
                .as_ref()
                .map(|members| members.0.clone()),
            retained_anchor: restoration.retained_anchor.clone(),
        })
        .map_err(|_| PoolPolicyError)?;
        if raw.len() > 65_536 {
            return Err(PoolPolicyError);
        }
        Ok(raw)
    }

    pub fn identity(&self) -> &ControllerBirthV2 {
        &self.birth
    }

    pub fn restored(&self) -> bool {
        self.restoration.is_some()
    }

    pub fn member_snapshot(&self) -> Option<&CommittedMemberSnapshot> {
        self.restoration.as_ref()?.members.as_ref()
    }

    pub fn retained_anchor(&self) -> Option<&RetainedPoolAnchor> {
        self.restoration.as_ref()?.retained_anchor.as_ref()
    }
}
