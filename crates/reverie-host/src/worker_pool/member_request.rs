//! Known refusal of a single member request before native observation, CID
//! admission or cgroup effects. Construction stays within the pool owner.
use super::{Result, need};
use crate::worker_laptop::{CreatedPoolTarget, MemberConfigurationAttempt};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize)]
enum RefusalCode {
    #[serde(rename = "WORKER_POOL_ACTIVATION_DEADLINE")]
    Deadline,
    #[serde(rename = "WORKER_POOL_MEMBER_CAPACITY_EXHAUSTED")]
    Capacity,
    #[serde(rename = "WORKER_POOL_MEMBER_ALREADY_ATTEMPTED")]
    AlreadyAttempted,
    #[serde(rename = "WORKER_POOL_MEMBER_POLICY")]
    Policy,
}

/// The original controller refused this request before beginning it. This is
/// neither a successful configuration nor permission to discard a prior owner.
#[derive(Debug)]
pub struct MemberRequestRefusal {
    code: RefusalCode,
    created: Option<MemberConfigurationAttempt>,
}

/// The first dispatch owns its nonce and previous uncertainty. Dropping this
/// record never clears uncertainty; only its exact closed refusal can do so.
pub(super) struct MemberRequestDispatch {
    request: String,
    prior_unknown: bool,
}

/// Correlated reply only. It cannot settle the actual controller's uncertainty
/// until that same owner has successfully rechecked its native identity.
pub(super) struct MemberRequestRefusalReceipt {
    refusal: MemberRequestRefusal,
    prior_unknown: bool,
}

impl MemberRequestRefusalReceipt {
    pub(super) fn require_original_known(&self) -> Result<()> {
        need(!self.prior_unknown, "WORKER_POOL_CONTROLLER_NOT_ACTIVE")
    }
    pub(super) fn settle_after_current(
        self,
        unknown: &mut bool,
        current: Result<()>,
    ) -> Result<MemberRequestRefusal> {
        current?;
        *unknown = self.prior_unknown;
        Ok(self.refusal)
    }
}

impl MemberRequestDispatch {
    pub(super) fn begin(request: String, unknown: &mut bool) -> Self {
        let prior_unknown = *unknown;
        *unknown = true;
        Self {
            request,
            prior_unknown,
        }
    }
    pub(super) fn request(&self) -> &str {
        &self.request
    }
    pub(super) fn refused(self, reply: &serde_json::Value) -> Option<MemberRequestRefusalReceipt> {
        let refusal = MemberRequestRefusal::from_correlated_reply(reply, &self.request)?;
        Some(MemberRequestRefusalReceipt {
            refusal,
            prior_unknown: self.prior_unknown,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RefusalReply {
    version: u8,
    request_id: String,
    phase: String,
    known: bool,
    primary_error: RefusalCode,
    anchor: RefusalAnchor,
}

// Anchor is bounded observation DATA only. Even a well-shaped value supplies
// no controller identity authority; the original owner reobserves that itself.
#[derive(Deserialize)]
#[serde(untagged)]
enum RefusalAnchor {
    Absent(()),
    Observed(RefusalAnchorData),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RefusalAnchorData {
    container: String,
    pid: u32,
}

impl RefusalAnchor {
    fn valid(&self) -> bool {
        match self {
            Self::Absent(()) => true,
            Self::Observed(data) => {
                reverie_contracts::worker_pool::hex_id(&data.container) && data.pid > 1
            }
        }
    }
}

impl MemberRequestRefusal {
    pub fn code(&self) -> &'static str {
        match self.code {
            RefusalCode::Deadline => "WORKER_POOL_ACTIVATION_DEADLINE",
            RefusalCode::Capacity => "WORKER_POOL_MEMBER_CAPACITY_EXHAUSTED",
            RefusalCode::AlreadyAttempted => "WORKER_POOL_MEMBER_ALREADY_ATTEMPTED",
            RefusalCode::Policy => "WORKER_POOL_MEMBER_POLICY",
        }
    }
    pub(super) fn deadline() -> Self {
        Self::new(RefusalCode::Deadline)
    }
    pub(super) fn capacity() -> Self {
        Self::new(RefusalCode::Capacity)
    }
    pub(super) fn already_attempted() -> Self {
        Self::new(RefusalCode::AlreadyAttempted)
    }
    pub(super) fn policy() -> Self {
        Self::new(RefusalCode::Policy)
    }
    fn new(code: RefusalCode) -> Self {
        Self {
            code,
            created: None,
        }
    }
    pub(super) fn bind_created(mut self, target: &CreatedPoolTarget<'_>) -> Self {
        self.created = Some(target.member_attempt());
        self
    }
    pub(crate) fn is_for_created(&self, attempt: &MemberConfigurationAttempt) -> bool {
        self.created
            .as_ref()
            .is_some_and(|original| original.same(attempt))
    }
    /// Only the original authenticated exchange supplies these bytes. A known
    /// flag or matching diagnostic on any other phase cannot settle issuance.
    fn from_correlated_reply(value: &serde_json::Value, expected_request: &str) -> Option<Self> {
        let reply: RefusalReply = serde_json::from_value(value.clone()).ok()?;
        (reply.version == 1
            && reply.request_id == expected_request
            && reply.phase == "memberRefused"
            && reply.known
            && reply.anchor.valid())
        .then_some(Self::new(reply.primary_error))
    }
}

#[cfg(test)]
mod tests;
