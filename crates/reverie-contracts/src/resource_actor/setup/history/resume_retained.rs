//! Preserved UNKNOWN history DATA, never completion, replay or wake authority.
use super::*;
use sha2::{Digest, Sha256};
pub struct RetainedExpiredResumeData {
    deployment: String,
    expires: u64,
}
impl RetainedExpiredResumeData {
    pub fn operation_id(raw: &[u8]) -> SetupResult<JournalId> {
        let active = parsed(raw)?;
        checked(closed(&active, &["purpose", "operationId", "planDigest"]))?;
        let fields = checked(object(&active))?;
        literal(field(fields, "purpose")?, crate::worker_resume::PURPOSE)?;
        JournalId::parse(&checked(scalar(field(fields, "operationId")?))?)
            .map_err(|_| ActorSetupDataError::Refused("ACTOR_SETUP_RESUME_OPERATION"))
    }
    pub fn capture(
        active: &[u8],
        plan: &[u8],
        attempt: &[u8],
        operation: &JournalId,
        directories: [[u64; 4]; 2],
        now: u64,
    ) -> SetupResult<Self> {
        let active = parsed(active)?;
        checked(closed(&active, &["purpose", "operationId", "planDigest"]))?;
        let attempt = parsed(attempt)?;
        checked(closed(&attempt, &["purpose", "planDigest"]))?;
        need_setup(plan.len() <= 16 * 1024 * 1024, "ACTOR_SETUP_HISTORY_BOUND")?;
        let actual_digest = crate::digest::hex(&Sha256::digest(plan).into());
        for value in [&active, &attempt] {
            let fields = checked(object(value))?;
            literal(field(fields, "purpose")?, crate::worker_resume::PURPOSE)?;
            literal(field(fields, "planDigest")?, &actual_digest)?;
        }
        literal(
            field(checked(object(&active))?, "operationId")?,
            operation.as_str(),
        )?;
        let plan = legacy_json::decode_strict_bytes(plan)
            .map_err(|_| ActorSetupDataError::Refused("ACTOR_SETUP_RESUME_PLAN_JSON"))?;
        checked(closed(
            &plan,
            &[
                "version",
                "purpose",
                "operationId",
                "snapshot",
                "deploymentPath",
                "expiresAt",
                "operationIdentity",
                "namespaceIdentity",
                "deploymentParents",
                "employeeIds",
            ],
        ))?;
        let fields = checked(object(&plan))?;
        need_setup(
            matches!(&field(fields, "version")?.0, Node::Number(Number::Integer(v)) if v == "1"),
            "ACTOR_SETUP_RESUME_PLAN_VERSION",
        )?;
        literal(field(fields, "purpose")?, crate::worker_resume::PURPOSE)?;
        literal(field(fields, "operationId")?, operation.as_str())?;
        for (name, expected) in [
            ("namespaceIdentity", directories[0]),
            ("operationIdentity", directories[1]),
        ] {
            let Node::Array(values) = &field(fields, name)?.0 else {
                return Err(ActorSetupDataError::Refused("ACTOR_SETUP_RESUME_DIRECTORY"));
            };
            need_setup(values.len() == 4 && values.iter().zip(expected).all(|(a,b)| {
                matches!(&a.0, Node::Number(Number::Integer(v)) if v == &b.to_string())
            }), "ACTOR_SETUP_RESUME_DIRECTORY")?;
        }
        let expires = checked(unsigned(field(fields, "expiresAt")?))?
            .to_u64()
            .filter(|n| *n > 0 && *n <= reverie_core::revision::JS_SAFE_MAX)
            .ok_or(ActorSetupDataError::Refused("ACTOR_SETUP_RESUME_EXPIRY"))?;
        let deployment = checked(scalar(field(fields, "deploymentPath")?))?;
        need_setup(
            deployment.starts_with('/') && !deployment.contains('\0'),
            "ACTOR_SETUP_RESUME_DEPLOYMENT",
        )?;
        let data = Self {
            deployment,
            expires,
        };
        data.assert_expired(now)?;
        Ok(data)
    }
    pub fn deployment_path(&self) -> &str {
        &self.deployment
    }
    pub fn assert_expired(&self, now: u64) -> SetupResult<()> {
        need_setup(now >= self.expires, "ACTOR_SETUP_RESUME_NOT_EXPIRED")
    }
}
