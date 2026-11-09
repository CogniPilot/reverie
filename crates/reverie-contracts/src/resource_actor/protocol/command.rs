//! NEW RAM command-current DATA follows the actual normal Session's JS compact
//! tuple hash, not an assertion of legacy Python ensure_ascii=False parity.
//! The full incoming request fingerprint is separate from the command digest.
use super::*;
use crate::worker_launch::WorkerRequest;
use reverie_core::{PythonTextRef, ids::NativeOperationId};
use sha2::{Digest, Sha256};

const COMMAND_REPLY_FIELDS: &[&str] = &[
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
    "employeeId",
    "reference",
    "sessionId",
    "cwd",
    "commandDigest",
    "requestDigest",
];
/// A projection of already observed request DATA. This grants no peer, owner,
/// launch, admission, pool or journal authority and contains no command/env text.
pub struct RamLaunchCommandData {
    approved: ResourceRequestSelection,
    reference: NativeOperationId,
    session: ProfileSessionId,
    directory: PythonText,
    command_digest: JournalDigest,
    request_digest: JournalDigest,
}
impl RamLaunchCommandData {
    pub fn from_observed_data(
        original: &ResourceOperationRequest,
        reference: &NativeOperationId,
        request: &WorkerRequest,
        request_digest: &JournalDigest,
    ) -> Result<Self> {
        let ResourceRequestSelection::Apply { target_sid, .. } = original.selection() else {
            return Err(ResourceActorDataError("RAM_APPROVAL_REQUIRED"));
        };
        need(
            target_sid == request.session() && request.attach_only() != Some(true),
            "RESOURCE_RAM_COMMAND_CHANGED",
        )?;
        let text = |points: &[u32]| {
            crate::js_json::Value::String(
                PythonTextRef::from_codepoints(points)
                    .expect("validated worker text")
                    .utf16_units(),
            )
        };
        let tuple = crate::js_json::Value::Array(vec![
            crate::js_json::Value::String(request.session().as_str().encode_utf16().collect()),
            text(request.directory().codepoints()),
            text(request.command().codepoints()),
        ]);
        let mut raw = String::new();
        crate::js_json::stringify(&tuple, &mut raw);
        let hash: [u8; 32] = Sha256::digest(raw.as_bytes()).into();
        Ok(Self {
            approved: original.selection().clone(),
            reference: reference.clone(),
            session: request.session().clone(),
            directory: PythonText::try_new(request.directory().codepoints().to_vec())
                .expect("validated worker directory"),
            command_digest: JournalDigest::parse(&crate::digest::hex(&hash)).expect("SHA256 hex"),
            request_digest: request_digest.clone(),
        })
    }
    pub fn reference(&self) -> &NativeOperationId {
        &self.reference
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn directory(&self) -> &PythonText {
        &self.directory
    }
    pub fn command_digest(&self) -> &JournalDigest {
        &self.command_digest
    }
    pub fn request_digest(&self) -> &JournalDigest {
        &self.request_digest
    }
    fn require_bound(
        &self,
        original: &ResourceOperationRequest,
        continuation: &ResourceContinuationRequest,
    ) -> Result<()> {
        continuation.require_original(original, &self.reference)?;
        need(
            continuation.verb() == ResourceContinuationVerb::Start
                && original.selection() == &self.approved,
            "RESOURCE_RAM_COMMAND_CHANGED",
        )
    }
}
impl ResourceOperationRequest {
    pub fn command_challenge(
        &self,
        continuation: &ResourceContinuationRequest,
        selected: &RamLaunchCommandData,
        nonce: &JournalId,
    ) -> Result<HumanFrame> {
        selected.require_bound(self, continuation)?;
        frame(Value(Node::Object(BTreeMap::from([
            (key("kind"), string("resource-command-check")),
            (key("requestId"), string(continuation.request_id().as_str())),
            (key("nonce"), string(nonce.as_str())),
            (key("purpose"), string(RAM_POOL_PURPOSE)),
            (key("stage"), string("apply")),
            (key("employeeId"), string(self.employee_id().as_str())),
            (key("reference"), string(selected.reference.as_str())),
            (key("sessionId"), string(selected.session.as_str())),
            (
                key("cwd"),
                Value(Node::String(Text(selected.directory.codepoints().to_vec()))),
            ),
            (
                key("commandDigest"),
                string(selected.command_digest.as_str()),
            ),
            (
                key("requestDigest"),
                string(selected.request_digest.as_str()),
            ),
            (key("approval"), self.approval_value()),
        ]))))
    }
    pub fn parse_command_reply(
        &self,
        frame: &HumanFrame,
        continuation: &ResourceContinuationRequest,
        selected: &RamLaunchCommandData,
        nonce: &JournalId,
    ) -> Result<CurrentResourceOwner> {
        selected.require_bound(self, continuation)?;
        let value = frame.value();
        let current = self.owner_reply_at(
            value,
            continuation.request_id(),
            nonce,
            "resource-command-current",
            COMMAND_REPLY_FIELDS,
        )?;
        for (name, expected) in [
            ("employeeId", self.employee_id().as_str()),
            ("reference", selected.reference.as_str()),
            ("sessionId", selected.session.as_str()),
            ("commandDigest", selected.command_digest.as_str()),
            ("requestDigest", selected.request_digest.as_str()),
        ] {
            literal(field(value, name)?, expected)?;
        }
        need(
            field(value, "cwd")?.python_eq(&Value(Node::String(Text(
                selected.directory.codepoints().to_vec(),
            )))),
            "RESOURCE_RAM_COMMAND_CHANGED",
        )?;
        Ok(current)
    }
}
