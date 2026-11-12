//! Proposed thresholds only. Explicit finite soft policies win; otherwise the
//! original effective hard ceiling is a proposal for the new soft threshold.
use super::*;
use crate::{
    broker_resources, device_policy::memory, storage_identity::Metadata,
    worker_config::EffectiveWorkerConfig,
};
use std::collections::BTreeSet;
impl PoolInstallationRequestData {
    pub fn proposed_employee_highs(
        config: &EffectiveWorkerConfig,
        company: &Metadata,
    ) -> Result<(BTreeMap<String, u32>, Vec<String>)> {
        let records = company
            .company_records()
            .map_err(|e| ResourceActorDataError(e.code()))?;
        let projection = broker_resources::projection(config.as_value())
            .map_err(|e| ResourceActorDataError(e.code()))?;
        let defaults = broker_resources::template_fields(config_fields(config))
            .and_then(|template| {
                template
                    .resolve(projection.reservation_pool())
                    .map_err(Into::into)
            })
            .map_err(|e| ResourceActorDataError(e.code()))?;
        need(
            defaults.pool_memory_mib() == crate::worker_pool::MEMORY_MAX_MIB
                && defaults.pool_tasks_max() == crate::worker_pool::TASKS_MAX,
            "POOL_NOMINATION_FIXED_POOL_REQUIRED",
        )?;
        let memory = memory::validate(config).map_err(|e| ResourceActorDataError(e.code()))?;
        need(
            memory.swap_pool_mib() == 0 && memory.policies().values().all(|p| p.swap_mib() == 0),
            "POOL_NOMINATION_SWAP_UNSUPPORTED",
        )?;
        reject_session_swap(config)?;
        let mut highs = BTreeMap::new();
        let mut fallbacks = Vec::new();
        let mut sessions = BTreeSet::new();
        for record in records.records() {
            let employee = record
                .canonical_identity()
                .map_err(|e| ResourceActorDataError(e.code()))?;
            let session = record
                .canonical_session()
                .map_err(|e| ResourceActorDataError(e.code()))?;
            let selected = session
                .as_ref()
                .and_then(|sid| projection.sessions().get(sid))
                .or_else(|| projection.employees().get(&employee));
            let effective = selected
                .map(|template| template.resolve(projection.reservation_pool()))
                .transpose()
                .map_err(|e| ResourceActorDataError(e.code()))?;
            let explicit = memory
                .selected(Some(&employee))
                .and_then(|policy| policy.memory_high_mib());
            let high =
                explicit.unwrap_or_else(|| effective.as_ref().unwrap_or(&defaults).memory_mib());
            need(
                (512..crate::worker_pool::MEMORY_MAX_MIB).contains(&high),
                "POOL_NOMINATION_SOFT_THRESHOLD",
            )?;
            if explicit.is_none() {
                fallbacks.push(employee.as_str().to_owned());
            }
            highs.insert(employee.as_str().to_owned(), high);
            if let Some(session) = session {
                sessions.insert(session);
            }
        }
        need(
            !highs.is_empty()
                && highs.len() <= 256
                && projection
                    .employees()
                    .keys()
                    .all(|id| highs.contains_key(id.as_str()))
                && projection.sessions().keys().all(|id| sessions.contains(id))
                && memory
                    .policies()
                    .keys()
                    .all(|id| highs.contains_key(id.as_str())),
            "POOL_NOMINATION_COMPLETE_COMPANY_REQUIRED",
        )?;
        Ok((highs, fallbacks))
    }
}
fn config_fields(config: &EffectiveWorkerConfig) -> &BTreeMap<Text, Value> {
    let Node::Object(fields) = &config.as_value().0 else {
        unreachable!("configuration object")
    };
    fields
}
fn reject_session_swap(config: &EffectiveWorkerConfig) -> Result<()> {
    let Some(entries) = config_fields(config).get(&key("sessionResources")) else {
        return Ok(());
    };
    let Node::Object(entries) = &entries.0 else {
        return Err(ResourceActorDataError("POOL_NOMINATION_SESSION_POLICY"));
    };
    for entry in entries.values() {
        if let Some(session) = crate::session_resources_v2::decode(entry)
            .map_err(|_| ResourceActorDataError("POOL_NOMINATION_SESSION_POLICY"))?
            && let Some(memory) = session.memory
        {
            need(
                memory.policy().swap_mib() == 0 && memory.swap_pool_mib() == 0,
                "POOL_NOMINATION_SWAP_UNSUPPORTED",
            )?;
        }
    }
    Ok(())
}
