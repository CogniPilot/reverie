//! A current nominated viewer is not consent and cannot consume an effect.
use super::*;
pub struct PoolInstallationViewRequest {
    request: JournalId,
}
pub struct PoolInstallationOfferViewData {
    binding: PoolInstallationConsentRequest,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CurrentPoolInstallationViewer {
    scope: JournalDigest,
    expires: u64,
    principal: ResourceOwnerPrincipal,
}
impl PoolInstallationViewRequest {
    pub fn decode(frame: &HumanFrame) -> Result<Self> {
        let value = frame.value();
        closed(value, &["kind", "purpose", "version", "requestId"])?;
        purpose_version(value)?;
        literal(field(value, "kind")?, "pool-installation-view")?;
        Ok(Self {
            request: identifier(field(value, "requestId")?)?,
        })
    }
    pub fn bind_offer_data(
        self,
        request: &PoolInstallationRequestData,
        nonce: &JournalId,
    ) -> PoolInstallationOfferViewData {
        PoolInstallationOfferViewData {
            binding: PoolInstallationConsentRequest {
                request: self.request,
                offer: nonce.clone(),
                digest: request.digest().clone(),
                principal: request.principal().clone(),
            },
        }
    }
}
impl PoolInstallationOfferViewData {
    pub fn offer_reply(&self, policy: &WorkerPoolPolicy, expires: u64) -> Result<HumanFrame> {
        let original = self.viewed_reply(policy, expires)?;
        let mut value = original.value().deep_clone();
        let Node::Object(fields) = &mut value.0 else {
            unreachable!()
        };
        fields.insert(key("kind"), string("pool-installation-offer"));
        frame(value)
    }
    pub fn owner_challenge(&self, nonce: &JournalId) -> Result<HumanFrame> {
        let original = self.binding.owner_challenge(nonce)?;
        let mut value = original.value().deep_clone();
        let Node::Object(fields) = &mut value.0 else {
            unreachable!()
        };
        fields.insert(key("kind"), string("pool-installation-view-check"));
        frame(value)
    }
    pub fn parse_owner_reply(
        &self,
        frame: &HumanFrame,
        nonce: &JournalId,
    ) -> Result<CurrentPoolInstallationViewer> {
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
                "ownerScopeDigest",
                "expiresAtEpochMs",
            ],
        )?;
        purpose_version(value)?;
        for (name, expected) in [
            ("kind", "pool-installation-view-current"),
            ("requestId", self.binding.request.as_str()),
            ("nonce", nonce.as_str()),
            ("offerNonce", self.binding.offer.as_str()),
            ("requestDigest", self.binding.digest.as_str()),
        ] {
            literal(field(value, name)?, expected)?;
        }
        let principal = ResourceOwnerPrincipal::capture(field(value, "principal")?)?;
        need(
            principal == self.binding.principal,
            "POOL_INSTALLATION_VIEW_PRINCIPAL_CHANGED",
        )?;
        let expires = unsigned(field(value, "expiresAtEpochMs")?)?
            .to_u64()
            .filter(|value| *value > 0 && *value <= reverie_core::revision::JS_SAFE_MAX)
            .ok_or(ResourceActorDataError("POOL_INSTALLATION_VIEW_EXPIRY"))?;
        Ok(CurrentPoolInstallationViewer {
            scope: digest(field(value, "ownerScopeDigest")?)?,
            expires,
            principal,
        })
    }
    pub fn viewed_reply(&self, policy: &WorkerPoolPolicy, expires: u64) -> Result<HumanFrame> {
        need(
            expires > 0 && expires <= reverie_core::revision::JS_SAFE_MAX,
            "POOL_INSTALLATION_VIEW_EXPIRY",
        )?;
        let raw = serde_json::to_vec(policy)
            .map_err(|_| ResourceActorDataError("POOL_INSTALLATION_VIEW_POLICY"))?;
        let policy = HumanFrame::decode(&raw).map_err(frame_error)?;
        frame(Value(Node::Object(BTreeMap::from([
            (key("kind"), string("pool-installation-viewed")),
            (key("purpose"), string(POOL_INSTALLATION_CONSENT_PURPOSE)),
            (
                key("version"),
                Value(Node::Number(Number::Integer("1".into()))),
            ),
            (key("requestId"), string(self.binding.request.as_str())),
            (key("offerNonce"), string(self.binding.offer.as_str())),
            (key("requestDigest"), string(self.binding.digest.as_str())),
            (key("principal"), self.binding.principal_value()),
            (key("policy"), policy.value().deep_clone()),
            (
                key("expiresAtEpochMs"),
                Value(Node::Number(Number::Integer(expires.to_string()))),
            ),
        ]))))
    }
    pub fn consent_request(&self, frame: &HumanFrame) -> Result<PoolInstallationConsentRequest> {
        let request = PoolInstallationConsentRequest::decode(frame)?;
        need(
            request == self.binding,
            "POOL_INSTALLATION_CONSENT_VIEW_CHANGED",
        )?;
        Ok(request)
    }
}
impl CurrentPoolInstallationViewer {
    pub fn principal(&self) -> &ResourceOwnerPrincipal {
        &self.principal
    }
    pub fn scope_digest(&self) -> &JournalDigest {
        &self.scope
    }
    pub fn expires_at_epoch_ms(&self) -> u64 {
        self.expires
    }
}
