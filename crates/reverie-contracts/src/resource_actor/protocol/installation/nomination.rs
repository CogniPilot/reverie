//! Pure nomination construction from explicit enrollment response DATA and a
//! separately derived policy. Only the real website owner can later consent.
use super::*;
mod policy;
mod revision;
impl PoolInstallationRequestData {
    /// Closed DATA validation only, before any native observation is necessary.
    pub fn validate_enrollment(enrollment: &[u8]) -> Result<()> {
        enrollment_principal(enrollment).map(|_| ())
    }
    pub fn from_enrollment(enrollment: &[u8], policy: &WorkerPoolPolicy) -> Result<Self> {
        let principal = enrollment_principal(enrollment)?;
        policy
            .validate()
            .map_err(|_| ResourceActorDataError("POOL_INSTALLATION_REQUEST_POLICY"))?;
        let raw_policy = serde_json::to_vec(policy)
            .map_err(|_| ResourceActorDataError("POOL_INSTALLATION_REQUEST_POLICY"))?;
        let policy = legacy_json::decode_strict_bytes(&raw_policy)
            .map_err(|_| ResourceActorDataError("POOL_INSTALLATION_REQUEST_POLICY"))?;
        let value = Value(Node::Object(BTreeMap::from([
            (key("purpose"), string(POOL_INSTALLATION_REQUEST_PURPOSE)),
            (
                key("version"),
                Value(Node::Number(Number::Integer("1".into()))),
            ),
            (key("principal"), principal.value()),
            (key("policy"), policy),
        ])));
        Self::decode(&crate::worker_config::compact_data(&value))
    }
}
fn enrollment_principal(enrollment: &[u8]) -> Result<ResourceOwnerPrincipal> {
    need(
        !enrollment.is_empty() && enrollment.len() <= 4096,
        "POOL_ENROLLMENT_INPUT_BOUND",
    )?;
    let frame = HumanFrame::decode(enrollment).map_err(frame_error)?;
    ResourceOwnerPrincipal::capture(frame.value())
}
