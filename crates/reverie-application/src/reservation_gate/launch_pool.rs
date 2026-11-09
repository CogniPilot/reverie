//! The new R pool purpose requires the actual selected SID policy. Global
//! feature presence or a caller's finite resource DATA cannot substitute.
use super::*;
use reverie_contracts::{
    reservation_engine::{ObservedMemoryPolicy, ReservationConfiguration},
    resource_config,
    worker_config::{WorkerPolicyDigest, policy_digest},
};
pub(super) fn candidate(
    config: &ReservationConfiguration,
    session: &ProfileSessionId,
    resources: &ResourcePolicy,
) -> Result<WorkerPolicyDigest> {
    need(
        resources.memory_mib() > 0,
        "RESERVATION_POOL_CANDIDATE_POLICY",
    )?;
    let effective =
        crate::resource_staging::effective_config(config.configuration().clone(), session)?;
    let policy = ObservedMemoryPolicy::from_effective(&effective)?;
    need(
        resource_config::checked_effective_policy(&effective)? == *resources
            && policy.as_ref().is_some_and(|policy| {
                policy.uses_pool()
                    && policy
                        .high()
                        .is_some_and(|high| !high.is_zero() && high < policy.memory())
            }),
        "RESERVATION_POOL_CANDIDATE_POLICY",
    )?;
    Ok(policy_digest(&effective))
}
