//! The exact fresh viewer echo. Parsing checks DATA, not clock or cookie state.
use super::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CurrentFleetPreviewViewer {
    scope: JournalDigest,
    expires: u64,
    principal: ResourceOwnerPrincipal,
}
impl CurrentFleetPreviewViewer {
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
impl FleetPreviewRequest {
    pub fn parse_owner_reply(
        &self,
        frame: &HumanFrame,
        nonce: &JournalId,
    ) -> Result<CurrentFleetPreviewViewer> {
        let value = frame.value();
        closed(
            value,
            &[
                "kind",
                "purpose",
                "version",
                "requestId",
                "nonce",
                "principal",
                "ownerScopeDigest",
                "expiresAtEpochMs",
            ],
        )?;
        purpose_version(value)?;
        for (name, expected) in [
            ("kind", "fleet-preview-owner-current"),
            ("requestId", self.request.as_str()),
            ("nonce", nonce.as_str()),
        ] {
            literal(field(value, name)?, expected)?;
        }
        let principal = ResourceOwnerPrincipal::capture(field(value, "principal")?)?;
        need(
            principal == self.principal,
            "FLEET_PREVIEW_PRINCIPAL_CHANGED",
        )?;
        let expires = unsigned(field(value, "expiresAtEpochMs")?)?
            .to_u64()
            .filter(|value| *value > 0 && *value <= reverie_core::revision::JS_SAFE_MAX)
            .ok_or(ResourceActorDataError("FLEET_PREVIEW_EXPIRY"))?;
        Ok(CurrentFleetPreviewViewer {
            scope: digest(field(value, "ownerScopeDigest")?)?,
            expires,
            principal,
        })
    }
}
