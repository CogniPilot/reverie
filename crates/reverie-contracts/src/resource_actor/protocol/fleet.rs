//! Distinct fleet-maintenance wire DATA; decoding grants no native authority.
use super::*;
use crate::reservation_control::PoolTransitionSelection;

pub const FLEET_MAINTENANCE_PURPOSE: &str = "resource-fleet-maintenance-v1";
mod owner;
mod reply;
mod result;
pub use owner::CurrentFleetMaintenanceOwner;
pub use reply::{FLEET_REPLY_MAX_FRAME, FleetReplyFrame, PreparedFleetMigrationReply};
mod preview;
pub use preview::{CurrentFleetPreviewViewer, FleetPreviewRequest};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FleetMaintenanceAction {
    Drain,
    MigratePool,
}
pub struct FleetMaintenanceRequest {
    action: FleetMaintenanceAction,
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
        let action = match &field(value, "verb")?.0 {
            Node::String(value) if value.equals_ascii("drain") => FleetMaintenanceAction::Drain,
            Node::String(value) if value.equals_ascii("migrate-pool") => {
                FleetMaintenanceAction::MigratePool
            }
            _ => return Err(ResourceActorDataError("FLEET_MAINTENANCE_VERB")),
        };
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
            action,
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
    pub fn action(&self) -> FleetMaintenanceAction {
        self.action
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
    let value = frame.value();
    literal(field(value, "purpose")?, FLEET_MAINTENANCE_PURPOSE)?;
    need(
        matches!(field(value, "replyVersion").map(|v| &v.0), Ok(Node::Number(Number::Integer(v))) if v == "2"),
        "FLEET_REPLY_CODEC_UPGRADE_REQUIRED",
    )?;
    closed(value, &["purpose", "version", "replyVersion"])?;
    purpose_version(value)
}
/// Routing DATA only. A matching purpose must still pass the closed codec
/// negotiation before a hold, preview, consent or fleet effect is possible.
pub fn is_fleet_maintenance_hello(raw: &[u8]) -> bool {
    HumanFrame::decode(raw).is_ok_and(|frame| {
        field(frame.value(), "purpose").is_ok_and(|v| literal(v, FLEET_MAINTENANCE_PURPOSE).is_ok())
    })
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

fn envelope_fields(kind: &str, request: &JournalId) -> BTreeMap<Text, Value> {
    BTreeMap::from([
        (key("kind"), string(kind)),
        (key("purpose"), string(FLEET_MAINTENANCE_PURPOSE)),
        (
            key("version"),
            Value(Node::Number(Number::Integer("1".into()))),
        ),
        (key("requestId"), string(request.as_str())),
    ])
}

#[cfg(test)]
mod tests;
