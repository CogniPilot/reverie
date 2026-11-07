//! Exact existing C reply json.dumps order/default separators, not a sorted
//! worker hash or journal encoding. Only the closed checked status is accepted.
use super::*;
use reverie_core::gpu_access::{GpuActiveData, GpuChoice, GpuDeviceUuid, GpuStatusData};
pub fn encode_status(status: &GpuStatusData) -> Vec<u8> {
    wire_object(&[
        ("version", b"1".to_vec()),
        ("employeeId", quoted(status.employee().as_str())),
        ("current", current(status)),
        (
            "revision",
            status
                .requested()
                .map_or(0, |row| row.revision())
                .to_string()
                .into_bytes(),
        ),
        ("choices", choices(status)),
        ("requested", requested(status)),
        ("applied", applied(status)),
        ("active", active(status)),
        ("state", quoted(status.state().as_str())),
    ])
}
fn current(status: &GpuStatusData) -> Vec<u8> {
    let binding = status.current();
    wire_object(&[
        ("sessionId", quoted(binding.session().as_str())),
        (
            "sessionGeneration",
            binding.generation().get().to_string().into_bytes(),
        ),
        ("bindingDigest", quoted(binding.digest().as_str())),
    ])
}
fn requested(status: &GpuStatusData) -> Vec<u8> {
    let Some(row) = status.requested() else {
        return b"null".to_vec();
    };
    wire_object(&[
        ("enabled", boolean(row.device().is_some())),
        ("deviceUuid", device(row.device())),
        ("revision", row.revision().to_string().into_bytes()),
    ])
}
fn applied(status: &GpuStatusData) -> Vec<u8> {
    wire_object(&[
        ("known", boolean(true)),
        ("enabled", boolean(status.applied().device().is_some())),
        ("deviceUuid", device(status.applied().device())),
        ("source", quoted(status.applied().source().as_str())),
    ])
}
fn active(status: &GpuStatusData) -> Vec<u8> {
    let (known, running, enabled, selected) = match status.active() {
        GpuActiveData::Stopped => (true, false, boolean(false), None),
        GpuActiveData::UnknownRunning => (false, true, b"null".to_vec(), None),
        GpuActiveData::ObservedDevice(device) => (true, true, boolean(true), Some(device)),
    };
    wire_object(&[
        ("known", boolean(known)),
        ("running", boolean(running)),
        ("enabled", enabled),
        ("deviceUuid", device(selected)),
    ])
}
fn choices(status: &GpuStatusData) -> Vec<u8> {
    let devices = status.choices().devices();
    let mut array = vec![b'['];
    for (index, value) in devices.unwrap_or(&[]).iter().enumerate() {
        if index > 0 {
            array.extend(b", ");
        }
        array.extend(choice(value));
    }
    array.push(b']');
    wire_object(&[("known", boolean(devices.is_some())), ("devices", array)])
}
fn choice(value: &GpuChoice) -> Vec<u8> {
    wire_object(&[
        ("deviceUuid", quoted(value.device().as_str())),
        ("model", quoted(value.model())),
    ])
}
fn boolean(value: bool) -> Vec<u8> {
    if value {
        b"true".to_vec()
    } else {
        b"false".to_vec()
    }
}
fn device(value: Option<&GpuDeviceUuid>) -> Vec<u8> {
    value.map_or_else(|| b"null".to_vec(), |value| quoted(value.as_str()))
}
fn quoted(value: &str) -> Vec<u8> {
    crate::worker_config::encode_data(&string(value))
}
fn wire_object(fields: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut output = vec![b'{'];
    for (index, (name, value)) in fields.iter().enumerate() {
        if index > 0 {
            output.extend(b", ");
        }
        output.extend(quoted(name));
        output.extend(b": ");
        output.extend(value);
    }
    output.push(b'}');
    output
}
