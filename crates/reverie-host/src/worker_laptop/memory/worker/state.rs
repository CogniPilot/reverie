use super::*;
use std::sync::MutexGuard;
pub(super) fn started(workflow: &LaptopWorkflow) -> Result<MutexGuard<'_, Record>> {
    let record = workflow
        .record
        .try_lock()
        .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
    need(
        record.phase == Phase::Known
            && !record.unknown
            && record.pending.is_none()
            && record
                .creation
                .as_ref()
                .is_some_and(|creation| creation.stage == create::CreateStage::Started),
        "WORKER_LAPTOP_MEMORY_PHASE",
    )?;
    Ok(record)
}
pub(super) fn pending(workflow: &LaptopWorkflow) -> Result<MutexGuard<'_, Record>> {
    let record = workflow
        .record
        .try_lock()
        .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
    need(
        record.phase == Phase::Known
            && !record.unknown
            && record.pending.is_none()
            && record.creation.as_ref().is_some_and(|creation| {
                creation.stage == create::CreateStage::ConfiguringMemory
                    && creation.worker_memory.is_some()
            }),
        "WORKER_LAPTOP_MEMORY_PHASE",
    )?;
    Ok(record)
}
pub(super) fn complete(
    record: &mut Record,
    workflow: &LaptopWorkflow,
    result: Result<()>,
) -> MemoryConfiguration {
    record.unknown |= result.as_ref().is_err_and(LaptopError::unconfirmed_native);
    record.outcome = Some(result.map_err(Arc::new));
    if record.pending.is_some() || record.unknown {
        record.phase = Phase::Retained;
        return MemoryConfiguration::Retained;
    }
    record.phase = Phase::Known;
    if record
        .outcome
        .as_ref()
        .expect("actual memory outcome")
        .is_err()
    {
        return MemoryConfiguration::Rejected;
    }
    record.creation.as_mut().expect("actual memory").stage = create::CreateStage::MemoryConfigured;
    MemoryConfiguration::Configured(ConfiguredMemory {
        workflow: workflow.clone(),
    })
}
pub(super) fn fail(pending: Pending, primary: LaptopError) -> Result<()> {
    match pending {
        Pending::Policy { .. } => Err(primary),
        Pending::Readback {
            target, attempted, ..
        } => classify(finalized(Err(primary), target.close()), attempted),
    }
}
