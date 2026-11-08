//! Explicit OS-operator selection DATA. Neither this document nor its digest
//! authenticates a website owner, consumes an offer or grants administration.
use super::*;
use crate::worker_pool::WorkerPoolPolicy;
use sha2::{Digest, Sha256};

pub const POOL_INSTALLATION_REQUEST_PURPOSE: &str = "host-pool-installation-request-v1";

pub struct PoolInstallationRequestData {
    principal: ResourceOwnerPrincipal,
    policy: WorkerPoolPolicy,
    digest: JournalDigest,
}
impl PoolInstallationRequestData {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        let frame = HumanFrame::decode(raw).map_err(frame_error)?;
        let value = frame.value();
        closed(value, &["purpose", "version", "principal", "policy"])?;
        literal(field(value, "purpose")?, POOL_INSTALLATION_REQUEST_PURPOSE)?;
        need(
            matches!(&field(value,"version")?.0,Node::Number(Number::Integer(value)) if value=="1"),
            "POOL_INSTALLATION_REQUEST_VERSION",
        )?;
        let principal = ResourceOwnerPrincipal::capture(field(value, "principal")?)?;
        let policy =
            WorkerPoolPolicy::decode(&crate::worker_config::compact_data(field(value, "policy")?))
                .map_err(|_| ResourceActorDataError("POOL_INSTALLATION_REQUEST_POLICY"))?;
        let canonical = frame.canonical().map_err(frame_error)?;
        let digest = JournalDigest::parse(&format!("{:x}", Sha256::digest(canonical)))
            .expect("SHA256 of canonical data");
        Ok(Self {
            principal,
            policy,
            digest,
        })
    }
    pub fn principal(&self) -> &ResourceOwnerPrincipal {
        &self.principal
    }
    pub fn policy(&self) -> &WorkerPoolPolicy {
        &self.policy
    }
    pub fn digest(&self) -> &JournalDigest {
        &self.digest
    }
}

#[cfg(test)]
mod tests;
