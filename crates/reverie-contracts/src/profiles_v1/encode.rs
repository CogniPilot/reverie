use super::{CodecError, MAX_BYTES, SCHEMA};
use reverie_core::profiles::{ProfileBinding, ProfileDocument, ResourceProfile};
use reverie_core::resources::{BudgetMode, CpuRepresentation, ResourcePolicy};

// All strings in this exact v1 schema are fixed ASCII literals or checked ASCII
// UUIDs. A future free-text field needs its own explicit escaping contract.
fn binding(value: &ProfileBinding) -> String {
    format!(
        "{{\"current_generation\":{},\"current_sid\":\"{}\",\"employee_id\":\"{}\",\"target_generation\":{},\"target_sid\":\"{}\"}}",
        value.current_generation().get(),
        value.current_session(),
        value.employee(),
        value.target_generation().get(),
        value.target_session()
    )
}
fn resources(value: &ResourcePolicy) -> String {
    let mode = match value.budget_mode() {
        BudgetMode::Admission => "admission",
        BudgetMode::Pool => "pool",
    };
    let cpu = match value.cpus().representation() {
        CpuRepresentation::Integer(integer) => integer.to_string(),
        // Finite CPU floats are zero or .25..64, avoiding Python's exponent
        // formatting thresholds. Debug preserves integral floats and -0.0.
        CpuRepresentation::Float(float) => format!("{float:?}"),
    };
    format!(
        "{{\"budgetMode\":\"{mode}\",\"cpus\":{cpu},\"memoryMiB\":{},\"pidsLimit\":{},\"poolMemoryMiB\":{},\"poolTasksMax\":{}}}",
        value.memory_mib(),
        value.pids_limit(),
        value.pool_memory_mib(),
        value.pool_tasks_max()
    )
}
fn profile(value: &ResourceProfile) -> String {
    format!(
        "{{\"binding\":{},\"resources\":{},\"version\":{}}}",
        binding(value.binding()),
        resources(value.resources()),
        value.version().get()
    )
}
fn bounded(value: String) -> Result<Vec<u8>, CodecError> {
    if value.len() > MAX_BYTES {
        Err(CodecError::StoreBound)
    } else {
        Ok(value.into_bytes())
    }
}
pub fn encode_profile(value: &ResourceProfile) -> Result<Vec<u8>, CodecError> {
    bounded(profile(value))
}
pub fn encode(value: &ProfileDocument) -> Result<Vec<u8>, CodecError> {
    let profiles = value
        .profiles()
        .iter()
        .map(|(employee, value)| format!("\"{employee}\":{}", profile(value)))
        .collect::<Vec<_>>()
        .join(",");
    bounded(format!(
        "{{\"profiles\":{{{profiles}}},\"revision\":{},\"schema\":\"{SCHEMA}\"}}",
        value.revision().get()
    ))
}
