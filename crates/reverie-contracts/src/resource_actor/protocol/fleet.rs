//! Distinct fleet-maintenance wire DATA; decoding grants no native authority.
use super::*;
use crate::reservation_control::PoolTransitionSelection;

pub const FLEET_MAINTENANCE_PURPOSE: &str = "resource-fleet-maintenance-v1";
mod owner;
pub use owner::CurrentFleetMaintenanceOwner;
pub struct FleetMaintenanceRequest {
    request: JournalId,
    selected: PoolTransitionSelection,
    principal: ResourceOwnerPrincipal,
}
impl FleetMaintenanceRequest {
    pub fn decode(frame: &HumanFrame) -> Result<Self> {
        let value = frame.value();
        closed(
            value,
            &[
                "kind",
                "purpose",
                "version",
                "verb",
                "requestId",
                "consent",
                "approval",
                "principal",
            ],
        )?;
        literal(field(value, "kind")?, "fleet-maintenance")?;
        literal(field(value, "verb")?, "drain")?;
        purpose_version(value)?;
        explicit_consent(value)?;
        let approved = field(value, "approval")?;
        closed(
            approved,
            &[
                "operationId",
                "previewId",
                "cohortDigest",
                "poolPolicyDigest",
                "coverageDigest",
                "revisionDigest",
            ],
        )?;
        Ok(Self {
            request: identifier(field(value, "requestId")?)?,
            selected: PoolTransitionSelection::new(
                identifier(field(approved, "operationId")?)?,
                identifier(field(approved, "previewId")?)?,
                digest(field(approved, "cohortDigest")?)?,
                digest(field(approved, "poolPolicyDigest")?)?,
                digest(field(approved, "coverageDigest")?)?,
                digest(field(approved, "revisionDigest")?)?,
            ),
            principal: ResourceOwnerPrincipal::capture(field(value, "principal")?)?,
        })
    }
    pub fn request_id(&self) -> &JournalId {
        &self.request
    }
    pub fn selection(&self) -> &PoolTransitionSelection {
        &self.selected
    }
    pub fn principal(&self) -> &ResourceOwnerPrincipal {
        &self.principal
    }
}
pub fn decode_fleet_maintenance_hello(raw: &[u8]) -> Result<()> {
    let frame = HumanFrame::decode(raw).map_err(frame_error)?;
    closed(frame.value(), &["purpose", "version"])?;
    purpose_version(frame.value())
}
fn purpose_version(value: &Value) -> Result<()> {
    literal(field(value, "purpose")?, FLEET_MAINTENANCE_PURPOSE)?;
    need(
        matches!(&field(value,"version")?.0,Node::Number(Number::Integer(value)) if value=="1"),
        "FLEET_MAINTENANCE_VERSION",
    )
}
fn explicit_consent(value: &Value) -> Result<()> {
    need(
        matches!(field(value, "consent")?.0, Node::Bool(true)),
        "FLEET_MAINTENANCE_CONSENT_REQUIRED",
    )
}

#[cfg(test)]
mod tests;
