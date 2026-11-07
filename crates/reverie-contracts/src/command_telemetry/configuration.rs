use crate::{
    legacy_json::{Node, Text, Value},
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::{
    command_telemetry::TelemetryConfiguration,
    worker_options::{TelemetryKey, WorkerOptionError},
};
/// Only the optional commandTelemetry value is read. Disabled/absent/null must
/// not inspect UID, filesystem roots, models, mounts or the engine.
pub fn configuration(
    config: &EffectiveWorkerConfig,
) -> Result<TelemetryConfiguration, WorkerOptionError> {
    let Node::Object(fields) = &config.as_value().0 else {
        unreachable!("worker object invariant")
    };
    let Some(value) = fields.get(&Text("commandTelemetry".chars().map(u32::from).collect())) else {
        return TelemetryConfiguration::try_new(false, Vec::new());
    };
    if matches!(value.0, Node::Null) {
        return TelemetryConfiguration::try_new(false, Vec::new());
    }
    let error = WorkerOptionError::Telemetry;
    let Node::Object(fields) = &value.0 else {
        return Err(error);
    };
    if fields
        .keys()
        .any(|key| !key.equals_ascii("enabled") && !key.equals_ascii("keys"))
    {
        return Err(error);
    }
    let field = |name: &str| fields.get(&Text(name.chars().map(u32::from).collect()));
    let Some(Value(Node::Bool(enabled))) = field("enabled") else {
        return Err(error);
    };
    let values = match field("keys") {
        None => &[][..],
        Some(Value(Node::Array(values))) => values.as_slice(),
        _ => return Err(error),
    };
    if values.len() > TelemetryKey::ALL.len() {
        return Err(error);
    }
    let keys = values
        .iter()
        .map(|value| {
            let Value(Node::String(value)) = value else {
                return Err(error);
            };
            let text = value
                .0
                .iter()
                .map(|&point| char::from_u32(point))
                .collect::<Option<String>>()
                .ok_or(error)?;
            TelemetryKey::parse(&text)
        })
        .collect::<Result<Vec<_>, _>>()?;
    TelemetryConfiguration::try_new(*enabled, keys)
}
