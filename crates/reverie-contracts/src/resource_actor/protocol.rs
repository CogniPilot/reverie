//! RAM-v2 request/challenge DATA. Parsing never authenticates an actual peer,
//! grants an owner operation, checks a clock or mints native custody.
use super::*;
use crate::human_protocol::HumanFrame;
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    operations::JournalId,
    revision::ProfileVersion,
};
mod approval;
mod installation;
mod owner;
mod principal;
mod registration;
#[cfg(test)]
mod tests;
pub use installation::{POOL_INSTALLATION_REQUEST_PURPOSE, PoolInstallationRequestData};
pub use owner::CurrentResourceOwner;
pub use principal::ResourceOwnerPrincipal;
pub use registration::{POOL_REGISTRATION_PURPOSE, decode_pool_registration_hello};
pub const RAM_POOL_PURPOSE: &str = "resource-ram-pool-v2";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResourceRequestSelection {
    Preview {
        employee_id: ProfileEmployeeId,
        idempotency_key: JournalId,
        requested_memory_mib: u32,
    },
    Apply {
        employee_id: ProfileEmployeeId,
        draft_id: JournalId,
        operation_id: JournalId,
        reservation_id: JournalId,
        target_sid: ProfileSessionId,
        profile_version: ProfileVersion,
        profile_digest: JournalDigest,
        preview_digest: JournalDigest,
        ram_policy_digest: JournalDigest,
    },
}
/// Immutable selection from the actual lossless frame. The original approval
/// is retained for exact owner echo and later canonical draft-version checks.
pub struct ResourceOperationRequest {
    request: JournalId,
    selected: ResourceRequestSelection,
    approval: Option<Value>,
}
pub fn decode_ram_pool_hello(raw: &[u8]) -> Result<()> {
    let frame = HumanFrame::decode(raw).map_err(frame_error)?;
    let value = frame.value();
    closed(value, &["purpose", "version"])?;
    literal(field(value, "purpose")?, RAM_POOL_PURPOSE)?;
    need(
        matches!(&field(value,"version")?.0,Node::Number(Number::Integer(value)) if value=="2"),
        "RESOURCE_RAM_HELLO_VERSION",
    )
}
impl ResourceOperationRequest {
    pub fn decode(frame: &HumanFrame) -> Result<Self> {
        let value = frame.value();
        literal(field(value, "kind")?, "resource-operation")?;
        let request = identifier(field(value, "requestId")?)?;
        let (selected, approval) = match scalar(field(value, "verb")?)?.as_str() {
            "draft" => {
                closed(
                    value,
                    &[
                        "kind",
                        "requestId",
                        "verb",
                        "employeeId",
                        "idempotencyKey",
                        "memoryMiB",
                    ],
                )?;
                let memory = unsigned(field(value, "memoryMiB")?)?
                    .to_u64()
                    .filter(|n| (512..=1_048_576).contains(n))
                    .ok_or(ResourceActorDataError("RESOURCE_PREPARATION_RAM_REQUEST"))?;
                (
                    ResourceRequestSelection::Preview {
                        employee_id: employee(field(value, "employeeId")?)?,
                        idempotency_key: identifier(field(value, "idempotencyKey")?)?,
                        requested_memory_mib: u32::try_from(memory).expect("bounded memory"),
                    },
                    None,
                )
            }
            "claim" => {
                closed(value, &["kind", "requestId", "verb", "approval"])?;
                let approved = field(value, "approval")?;
                (approval::decode(approved)?, Some(approved.deep_clone()))
            }
            _ => return Err(ResourceActorDataError("RESOURCE_RAM_CLOSED_OPERATION")),
        };
        Ok(Self {
            request,
            selected,
            approval,
        })
    }
    pub fn request_id(&self) -> &JournalId {
        &self.request
    }
    pub fn selection(&self) -> &ResourceRequestSelection {
        &self.selected
    }
    pub fn employee_id(&self) -> &ProfileEmployeeId {
        match &self.selected {
            ResourceRequestSelection::Preview { employee_id, .. }
            | ResourceRequestSelection::Apply { employee_id, .. } => employee_id,
        }
    }
    /// Python first converts int(profileVersion), then the actual draft join
    /// separately requires its ORIGINAL value to equal str(draft.version).
    /// Do not grant a normalized numeric approval by skipping this late check.
    pub fn require_profile_version(&self, expected: ProfileVersion) -> Result<()> {
        let approval = self
            .approval
            .as_ref()
            .ok_or(ResourceActorDataError("RESOURCE_RAM_APPROVAL_REQUIRED"))?;
        literal(
            field(approval, "profileVersion")?,
            &expected.get().to_string(),
        )
    }
    fn stage(&self) -> &'static str {
        if self.approval.is_some() {
            "apply"
        } else {
            "preview"
        }
    }
    fn approval_value(&self) -> Value {
        self.approval
            .as_ref()
            .map_or(Value(Node::Null), Value::deep_clone)
    }
}
fn identifier(value: &Value) -> Result<JournalId> {
    JournalId::parse(&scalar(value)?).map_err(|_| ResourceActorDataError("RESOURCE_RAM_UUID"))
}
fn employee(value: &Value) -> Result<ProfileEmployeeId> {
    ProfileEmployeeId::parse(identifier(value)?.as_str())
        .map_err(|_| ResourceActorDataError("RESOURCE_RAM_UUID"))
}
fn literal(value: &Value, expected: &str) -> Result<()> {
    need(
        matches!(&value.0,Node::String(value) if value.equals_ascii(expected)),
        "RESOURCE_RAM_BINDING_CHANGED",
    )
}
fn frame_error(_: crate::human_protocol::HumanFrameError) -> ResourceActorDataError {
    ResourceActorDataError("RESOURCE_RAM_FRAME")
}
fn frame(value: Value) -> Result<HumanFrame> {
    HumanFrame::decode(&crate::worker_config::compact_data(&value)).map_err(frame_error)
}
fn string(value: &str) -> Value {
    Value(Node::String(key(value)))
}
