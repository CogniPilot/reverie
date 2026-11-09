//! Closed global-consent DATA. Only the actual retained OS offer and attested
//! B channel can join these values to current human consent. Parsing supplies
//! no host administration, pool membership or employee operation authority.
use super::*;

pub const POOL_INSTALLATION_CONSENT_PURPOSE: &str = "host-pool-installation-consent-v1";
mod view;
pub use view::{
    CurrentPoolInstallationViewer, PoolInstallationOfferViewData, PoolInstallationViewRequest,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolInstallationConsentRequest {
    request: JournalId,
    offer: JournalId,
    digest: JournalDigest,
    principal: ResourceOwnerPrincipal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CurrentPoolInstallationConsent {
    scope: JournalDigest,
    expires: u64,
    principal: ResourceOwnerPrincipal,
}
impl CurrentPoolInstallationConsent {
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
impl PoolInstallationConsentRequest {
    /// Observation DATA after the native owner has actually configured and
    /// transferred its controller. This frame itself grants no authority.
    pub fn configured_reply(&self, observed: &[u8]) -> Result<HumanFrame> {
        let observed = HumanFrame::decode(observed).map_err(frame_error)?;
        need(
            matches!(observed.value().0, Node::Object(_)),
            "POOL_INSTALLATION_OBSERVATION_OBJECT_REQUIRED",
        )?;
        frame(Value(Node::Object(BTreeMap::from([
            (key("kind"), string("pool-installation-result")),
            (key("purpose"), string(POOL_INSTALLATION_CONSENT_PURPOSE)),
            (
                key("version"),
                Value(Node::Number(Number::Integer("1".into()))),
            ),
            (key("requestId"), string(self.request.as_str())),
            (key("phase"), string("pool-configured")),
            (key("observed"), observed.value().deep_clone()),
        ]))))
    }
    pub fn decode(frame: &HumanFrame) -> Result<Self> {
        let value = frame.value();
        closed(
            value,
            &[
                "kind",
                "purpose",
                "version",
                "requestId",
                "offerNonce",
                "requestDigest",
                "principal",
                "consent",
            ],
        )?;
        literal(field(value, "kind")?, "pool-installation-consent")?;
        purpose_version(value)?;
        explicit_consent(value)?;
        Ok(Self {
            request: identifier(field(value, "requestId")?)?,
            offer: identifier(field(value, "offerNonce")?)?,
            digest: digest(field(value, "requestDigest")?)?,
            principal: ResourceOwnerPrincipal::capture(field(value, "principal")?)?,
        })
    }
    pub fn request_id(&self) -> &JournalId {
        &self.request
    }
    pub fn offer_nonce(&self) -> &JournalId {
        &self.offer
    }
    pub fn request_digest(&self) -> &JournalDigest {
        &self.digest
    }
    pub fn principal(&self) -> &ResourceOwnerPrincipal {
        &self.principal
    }
    pub fn owner_challenge(&self, nonce: &JournalId) -> Result<HumanFrame> {
        frame(Value(Node::Object(BTreeMap::from([
            (key("kind"), string("pool-installation-owner-check")),
            (key("purpose"), string(POOL_INSTALLATION_CONSENT_PURPOSE)),
            (
                key("version"),
                Value(Node::Number(Number::Integer("1".into()))),
            ),
            (key("requestId"), string(self.request.as_str())),
            (key("nonce"), string(nonce.as_str())),
            (key("offerNonce"), string(self.offer.as_str())),
            (key("requestDigest"), string(self.digest.as_str())),
            (key("principal"), self.principal_value()),
        ]))))
    }
    pub fn parse_owner_reply(
        &self,
        frame: &HumanFrame,
        nonce: &JournalId,
    ) -> Result<CurrentPoolInstallationConsent> {
        let value = frame.value();
        closed(
            value,
            &[
                "kind",
                "purpose",
                "version",
                "requestId",
                "nonce",
                "offerNonce",
                "requestDigest",
                "principal",
                "consent",
                "ownerScopeDigest",
                "expiresAtEpochMs",
            ],
        )?;
        purpose_version(value)?;
        for (name, expected) in [
            ("kind", "pool-installation-owner-current"),
            ("requestId", self.request.as_str()),
            ("nonce", nonce.as_str()),
            ("offerNonce", self.offer.as_str()),
            ("requestDigest", self.digest.as_str()),
        ] {
            literal(field(value, name)?, expected)?;
        }
        explicit_consent(value)?;
        let principal = ResourceOwnerPrincipal::capture(field(value, "principal")?)?;
        need(
            principal == self.principal,
            "POOL_INSTALLATION_CONSENT_PRINCIPAL_CHANGED",
        )?;
        let expires = unsigned(field(value, "expiresAtEpochMs")?)?
            .to_u64()
            .filter(|value| *value > 0 && *value <= reverie_core::revision::JS_SAFE_MAX)
            .ok_or(ResourceActorDataError("POOL_INSTALLATION_CONSENT_EXPIRY"))?;
        Ok(CurrentPoolInstallationConsent {
            scope: digest(field(value, "ownerScopeDigest")?)?,
            expires,
            principal,
        })
    }
    fn principal_value(&self) -> Value {
        Value(Node::Object(BTreeMap::from([
            (key("accountId"), string(self.principal.account_id())),
            (key("personId"), string(self.principal.person_id())),
            (
                key("sessionEpoch"),
                Value(Node::Number(Number::Integer(
                    self.principal.session_epoch().to_string(),
                ))),
            ),
        ])))
    }
}
fn purpose_version(value: &Value) -> Result<()> {
    literal(field(value, "purpose")?, POOL_INSTALLATION_CONSENT_PURPOSE)?;
    need(
        matches!(&field(value,"version")?.0,Node::Number(Number::Integer(value)) if value=="1"),
        "POOL_INSTALLATION_CONSENT_VERSION",
    )
}
fn explicit_consent(value: &Value) -> Result<()> {
    need(
        matches!(field(value, "consent")?.0, Node::Bool(true)),
        "POOL_INSTALLATION_CONSENT_REQUIRED",
    )
}

#[cfg(test)]
mod tests;
