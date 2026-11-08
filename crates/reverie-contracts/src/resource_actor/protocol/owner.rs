use super::*;
pub(super) const OWNER_REPLY_FIELDS: &[&str] = &[
    "kind",
    "requestId",
    "nonce",
    "purpose",
    "stage",
    "owner",
    "ownerScopeDigest",
    "expiresAtEpochMs",
    "approval",
    "principal",
];
/// One reply's immutable DATA. Equality is useful for the actual owner's
/// repeated challenge signature; it is not current-cookie/channel authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CurrentResourceOwner {
    owner: Option<PythonText>,
    scope: JournalDigest,
    expires: u64,
    principal: ResourceOwnerPrincipal,
}
impl CurrentResourceOwner {
    pub fn owner(&self) -> &Option<PythonText> {
        &self.owner
    }
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
impl ResourceOperationRequest {
    pub fn owner_challenge(&self, nonce: &JournalId) -> Result<HumanFrame> {
        self.owner_challenge_at(self.request_id(), nonce)
    }
    pub(super) fn owner_challenge_at(
        &self,
        request_id: &JournalId,
        nonce: &JournalId,
    ) -> Result<HumanFrame> {
        frame(Value(Node::Object(BTreeMap::from([
            (key("kind"), string("resource-owner-check")),
            (key("requestId"), string(request_id.as_str())),
            (key("nonce"), string(nonce.as_str())),
            (key("stage"), string(self.stage())),
            (key("employeeId"), string(self.employee_id().as_str())),
            (key("approval"), self.approval_value()),
        ]))))
    }
    pub fn parse_owner_reply(
        &self,
        frame: &HumanFrame,
        nonce: &JournalId,
    ) -> Result<CurrentResourceOwner> {
        self.owner_reply_at(
            frame.value(),
            self.request_id(),
            nonce,
            "resource-owner-current",
            OWNER_REPLY_FIELDS,
        )
    }
    pub(super) fn owner_reply_at(
        &self,
        value: &Value,
        request_id: &JournalId,
        nonce: &JournalId,
        expected_kind: &'static str,
        fields: &[&str],
    ) -> Result<CurrentResourceOwner> {
        closed(value, fields)?;
        for (name, expected) in [
            ("kind", expected_kind),
            ("requestId", request_id.as_str()),
            ("nonce", nonce.as_str()),
            ("purpose", RAM_POOL_PURPOSE),
            ("stage", self.stage()),
        ] {
            literal(field(value, name)?, expected)?;
        }
        need(
            field(value, "approval")?.python_eq(&self.approval_value()),
            "RESOURCE_RAM_APPROVAL_CHANGED",
        )?;
        let owner = match &field(value, "owner")?.0 {
            Node::Null => None,
            Node::String(value) if value.0.len() <= 200 => {
                Some(PythonText::try_new(value.0.clone()).expect("JSON codepoints"))
            }
            _ => return Err(ResourceActorDataError("RESOURCE_RAM_OWNER")),
        };
        let expires = unsigned(field(value, "expiresAtEpochMs")?)?
            .to_u64()
            .filter(|value| *value > 0)
            .ok_or(ResourceActorDataError("RESOURCE_RAM_EXPIRY"))?;
        Ok(CurrentResourceOwner {
            owner,
            scope: digest(field(value, "ownerScopeDigest")?)?,
            expires,
            principal: ResourceOwnerPrincipal::capture(field(value, "principal")?)?,
        })
    }
}
