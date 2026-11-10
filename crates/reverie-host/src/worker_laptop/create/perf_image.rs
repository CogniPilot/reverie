//! Actual task-v2 image/capsule pair, checked before the one-shot create.
//! This is not a substitute for the later actual pinned guest-code readback.
use super::*;
use reverie_core::task_perf::TaskPerfPolicy;
pub(super) fn assert_current(
    runtime: &WorkerRuntime,
    record: &mut Record,
    deadline: CallBudget,
) -> Result<()> {
    let selected = reverie_contracts::task_perf_v1::projected_selection(
        record.resources().plan.effective_configuration(),
    )
    .map_err(LaptopError::PerfData)?;
    if selected != Some(TaskPerfPolicy::TaskV2) {
        return Ok(());
    }
    let manifest = crate::task_perf::capsule::manifest_reference()
        .ok_or(LaptopError::Refused("TASK_PERF_CAPSULE_UNCONFIGURED"))?;
    let image = record
        .resources()
        .plan
        .arguments()
        .image()
        .scalar_text()
        .ok_or(LaptopError::Refused("TASK_PERF_IMMUTABLE_IMAGE_REQUIRED"))?;
    let output = network::call_with_budget(
        runtime,
        record,
        vec!["image".into(), "inspect".into(), image.clone().into()],
        network::CallPurpose::Observe,
        deadline,
    )?;
    need(output.succeeded, "TASK_PERF_IMAGE_INSPECTION_REQUIRED")?;
    reverie_contracts::task_perf_capsule::assert_image_binding(&output.stdout, &image, manifest)
        .map_err(|error| {
            LaptopError::PerfCapsule(crate::task_perf::PerfCapsuleFailure::new(
                crate::task_perf::capsule::CapsuleError::Data(error),
            ))
        })
}
