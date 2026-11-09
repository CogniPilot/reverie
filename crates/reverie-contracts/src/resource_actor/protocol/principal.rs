//! Registration incarnation DATA. Only the actual ROOT/Office producer can
//! qualify it; parsing these identifiers creates no operation or owner grant.
use super::*;
use reverie_core::ids::NativeOperationId;

#[derive(Clone, Debug, Eq, PartialEq)]
struct PrincipalUuid(NativeOperationId);
impl PrincipalUuid {
    fn capture(value: &Value) -> Result<Self> {
        NativeOperationId::parse(&scalar(value)?)
            .map(Self)
            .map_err(|_| ResourceActorDataError("RESOURCE_RAM_PRINCIPAL_UUID"))
    }
    fn as_str(&self) -> &str {
        self.0.as_str()
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
enum Person {
    Owner,
    Office(PrincipalUuid),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceOwnerPrincipal {
    account: PrincipalUuid,
    person: Person,
    epoch: u64,
}
impl ResourceOwnerPrincipal {
    pub(super) fn capture(value: &Value) -> Result<Self> {
        closed(value, &["accountId", "personId", "sessionEpoch"])?;
        let account = PrincipalUuid::capture(field(value, "accountId")?)?;
        let person = field(value, "personId")?;
        let person = if scalar(person)? == "owner" {
            Person::Owner
        } else {
            Person::Office(PrincipalUuid::capture(person)?)
        };
        let epoch = unsigned(field(value, "sessionEpoch")?)?
            .to_u64()
            .filter(|value| *value <= reverie_core::revision::JS_SAFE_MAX)
            .ok_or(ResourceActorDataError("RESOURCE_RAM_PRINCIPAL_EPOCH"))?;
        Ok(Self {
            account,
            person,
            epoch,
        })
    }
    pub fn account_id(&self) -> &str {
        self.account.as_str()
    }
    pub fn person_id(&self) -> &str {
        match &self.person {
            Person::Owner => "owner",
            Person::Office(value) => value.as_str(),
        }
    }
    pub fn session_epoch(&self) -> u64 {
        self.epoch
    }
}
