//! A fresh echo of immutable request DATA, not native or cookie authority.
use super::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CurrentFleetMaintenanceOwner {
    scope: JournalDigest,
    expires: u64,
    principal: ResourceOwnerPrincipal,
}
impl CurrentFleetMaintenanceOwner {
    pub fn scope_digest(&self) -> &JournalDigest {
        &self.scope
    }
    pub fn expires_at_epoch_ms(&self) -> u64 {
        self.expires
    }
    pub fn principal(&self) -> &ResourceOwnerPrincipal {
        &self.principal
    }
}
impl FleetMaintenanceRequest {
    pub fn owner_challenge(&self, nonce: &JournalId) -> Result<HumanFrame> {
        let mut fields = envelope_fields("fleet-maintenance-owner-check", &self.request);
        fields.extend([
            (key("nonce"), string(nonce.as_str())),
            (key("approval"), self.selected.approval_value()),
            (key("principal"), self.principal.value()),
        ]);
        frame(Value(Node::Object(fields)))
    }
    pub fn parse_owner_reply(
        &self,
        frame: &HumanFrame,
        nonce: &JournalId,
    ) -> Result<CurrentFleetMaintenanceOwner> {
        let value = frame.value();
        closed(
            value,
            &[
                "kind",
                "purpose",
                "version",
                "requestId",
                "nonce",
                "approval",
                "principal",
                "consent",
                "ownerScopeDigest",
                "expiresAtEpochMs",
            ],
        )?;
        purpose_version(value)?;
        explicit_consent(value)?;
        self.assert_owner_binding(value, nonce)?;
        let expires = unsigned(field(value, "expiresAtEpochMs")?)?
            .to_u64()
            .filter(|value| *value > 0 && *value <= reverie_core::revision::JS_SAFE_MAX)
            .ok_or(ResourceActorDataError("FLEET_MAINTENANCE_EXPIRY"))?;
        Ok(CurrentFleetMaintenanceOwner {
            scope: digest(field(value, "ownerScopeDigest")?)?,
            expires,
            principal: self.principal.clone(),
        })
    }
    fn assert_owner_binding(&self, value: &Value, nonce: &JournalId) -> Result<()> {
        for (field_name, expected) in [
            ("kind", "fleet-maintenance-owner-current"),
            ("requestId", self.request.as_str()),
            ("nonce", nonce.as_str()),
        ] {
            literal(field(value, field_name)?, expected)?;
        }
        need(
            field(value, "approval")?.python_eq(&self.selected.approval_value())
                && ResourceOwnerPrincipal::capture(field(value, "principal")?)? == self.principal,
            "FLEET_MAINTENANCE_APPROVAL_CHANGED",
        )
    }
}
