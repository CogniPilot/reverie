//! Immutable approval data echoed on the same authenticated resource channel.
use super::*;
use crate::worker_pool::WorkerPoolMemberPolicy;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmployeePolicyEdit {
    session: ProfileSessionId,
    operation: JournalId,
    revision: JournalDigest,
    requested: WorkerPoolMemberPolicy,
}

impl EmployeePolicyEdit {
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }

    pub fn operation(&self) -> &JournalId {
        &self.operation
    }

    pub fn revision(&self) -> &JournalDigest {
        &self.revision
    }

    pub fn requested(&self) -> WorkerPoolMemberPolicy {
        self.requested
    }

    fn decode(value: &Value) -> Result<Self> {
        closed(
            value,
            &[
                "sessionId",
                "operationId",
                "expectedRevision",
                "memoryHighMiB",
                "cpuWeight",
            ],
        )?;
        let session = identifier(field(value, "sessionId")?)?;
        Ok(Self {
            session: ProfileSessionId::parse(session.as_str())
                .map_err(|_| ResourceActorDataError("EMPLOYEE_RESOURCE_CURRENT_SESSION"))?,
            operation: identifier(field(value, "operationId")?)?,
            revision: digest(field(value, "expectedRevision")?)?,
            requested: WorkerPoolMemberPolicy::new(
                number(value, "memoryHighMiB")?,
                number(value, "cpuWeight")?,
            )
            .map_err(|_| ResourceActorDataError("EMPLOYEE_RESOURCE_POLICY_INVALID"))?,
        })
    }
}

pub(super) fn request(value: &Value) -> Result<(ResourceRequestSelection, Option<Value>)> {
    closed(
        value,
        &["kind", "requestId", "verb", "employeeId", "approval"],
    )?;
    let approval = field(value, "approval")?;
    Ok((
        ResourceRequestSelection::EmployeePolicyEdit {
            employee_id: employee(field(value, "employeeId")?)?,
            approval: EmployeePolicyEdit::decode(approval)?,
        },
        Some(approval.deep_clone()),
    ))
}

fn number(value: &Value, name: &str) -> Result<u32> {
    unsigned(field(value, name)?)?
        .to_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(ResourceActorDataError("EMPLOYEE_RESOURCE_POLICY_INVALID"))
}

impl ResourceOperationRequest {
    pub(super) fn require_employee_policy_edit_echo(&self, value: &Value) -> Result<()> {
        if let ResourceRequestSelection::EmployeePolicyEdit { approval, .. } = self.selection() {
            need(
                EmployeePolicyEdit::decode(value)? == *approval,
                "EMPLOYEE_RESOURCE_APPROVAL_CHANGED",
            )?;
        }
        Ok(())
    }
}
