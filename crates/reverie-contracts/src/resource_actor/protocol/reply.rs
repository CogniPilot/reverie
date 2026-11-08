//! Closed reply DATA for the original request. No reply constitutes execution,
//! admission, owner approval or historical native settlement.
use super::*;
use crate::{profiles_v1, ram_migration::RamMigrationPolicy};
use reverie_core::{profiles::ResourceProfile, resources::ResourceTemplate};
#[cfg(test)]
mod tests;

pub struct RamPreviewFields<'a> {
    pub draft_id: &'a JournalId,
    pub operation_id: &'a JournalId,
    pub reservation_id: &'a JournalId,
    pub profile: &'a ResourceProfile,
    pub preview_digest: &'a JournalDigest,
    pub ram_policy: &'a RamMigrationPolicy,
    pub source_memory_mib: u64,
}
impl ResourceOperationRequest {
    pub fn preview_reply(&self, data: RamPreviewFields<'_>) -> Result<HumanFrame> {
        let ResourceRequestSelection::Preview {
            employee_id,
            requested_memory_mib,
            ..
        } = self.selection()
        else {
            return Err(ResourceActorDataError("RESOURCE_RAM_PREVIEW_REQUIRED"));
        };
        need(
            data.profile.binding().employee() == employee_id
                && data.profile.resources().memory_mib() == *requested_memory_mib
                && profiles_v1::equivalent(data.profile, data.ram_policy.profile())
                && data.source_memory_mib <= u64::MAX / reverie_core::operations::MIB,
            "RESOURCE_RAM_BINDING_CHANGED",
        )?;
        let profile_digest = profiles_v1::profile_digest(data.profile)
            .map_err(|_| ResourceActorDataError("RESOURCE_RAM_BINDING_CHANGED"))?;
        let mut resources = crate::broker_resources::resource_fields(&ResourceTemplate::from(
            data.profile.resources(),
        ));
        // The original wire adapter normalizes integral CPU floats, while the
        // actual profile bytes/digest above retain their original provenance.
        if let Some(Value(Node::Number(Number::Float(value)))) = resources.get_mut(&key("cpus"))
            && value.fract() == 0.0
        {
            let value = if *value == 0.0 {
                "0".to_owned()
            } else {
                format!("{value:.0}")
            };
            resources.insert(key("cpus"), integer(value));
        }
        let value = Value(Node::Object(BTreeMap::from([
            (key("draftId"), string(data.draft_id.as_str())),
            (key("operationId"), string(data.operation_id.as_str())),
            (key("reservationId"), string(data.reservation_id.as_str())),
            (
                key("targetSid"),
                string(data.profile.binding().target_session().as_str()),
            ),
            (
                key("profileVersion"),
                string(&data.profile.version().get().to_string()),
            ),
            (key("profileDigest"), string(&profile_digest.to_hex())),
            (key("previewDigest"), string(data.preview_digest.as_str())),
            (
                key("ramPolicyDigest"),
                string(data.ram_policy.digest().as_str()),
            ),
            (key("resources"), Value(Node::Object(resources))),
            (
                key("sourceMemoryMiB"),
                integer(data.source_memory_mib.to_string()),
            ),
            (key("capacityHeld"), Value(Node::Bool(false))),
            (key("nativeEffects"), Value(Node::Bool(false))),
        ])));
        self.result_reply(value)
    }
    pub fn refusal_reply(&self, reason: &str) -> Result<HumanFrame> {
        need(
            (1..=96).contains(&reason.len())
                && reason
                    .bytes()
                    .next()
                    .is_some_and(|c| c.is_ascii_uppercase())
                && reason
                    .bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_'),
            "RESOURCE_RAM_REFUSAL_CODE",
        )?;
        frame(Value(Node::Object(BTreeMap::from([
            (key("kind"), string("resource-refused")),
            (key("requestId"), string(self.request_id().as_str())),
            (key("reason"), string(reason)),
        ]))))
    }
    fn result_reply(&self, value: Value) -> Result<HumanFrame> {
        frame(Value(Node::Object(BTreeMap::from([
            (key("kind"), string("resource-result")),
            (key("requestId"), string(self.request_id().as_str())),
            (key("value"), value),
        ]))))
    }
}
fn integer(value: String) -> Value {
    Value(Node::Number(Number::Integer(value)))
}
