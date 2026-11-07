use super::{GpuAccessError, Result};
use crate::{
    device_policy::NvidiaCdiDevice,
    python_text::{python_lowercase_string, python_numeric_text, trim_text},
};
use std::collections::BTreeMap;

/// Parsed current kernel-driver DATA. Matching a device UUID says nothing
/// about grants, a live guest node, or a successful device workload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PhysicalGpu {
    uuid: String,
    pci: String,
    minor: String,
    model: String,
}
impl PhysicalGpu {
    /// Source information-file UTF-8 is decoded by the bounded host reader.
    /// Colon fields are last-wins and Python splitlines/strip remain distinct
    /// from Rust whitespace/lines and from a JSON parser.
    pub fn selected(raw: &str, device: &NvidiaCdiDevice) -> Result<Option<Self>> {
        let fields = fields(raw);
        let identity = trim_text(fields.get("GPU UUID").copied().unwrap_or(""));
        if python_lowercase_string(&format!("nvidia.com/gpu={identity}"))
            != python_lowercase_string(device.as_str())
        {
            return Ok(None);
        }
        NvidiaCdiDevice::parse(&format!("nvidia.com/gpu={identity}"))
            .map_err(|_| GpuAccessError::PhysicalMetadata)?;
        let pci = trim_text(fields.get("Bus Location").copied().unwrap_or(""));
        let minor = trim_text(fields.get("Device Minor").copied().unwrap_or(""));
        if !pci_valid(pci)
            || minor.is_empty()
            || !python_numeric_text(minor)
                .is_some_and(|value| value.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return Err(GpuAccessError::PhysicalMetadata);
        }
        Ok(Some(Self {
            uuid: identity.into(),
            pci: pci.into(),
            minor: minor.into(),
            model: trim_text(fields.get("Model").copied().unwrap_or(""))
                .chars()
                .take(128)
                .collect(),
        }))
    }
    pub fn uuid(&self) -> &str {
        &self.uuid
    }
    pub fn pci(&self) -> &str {
        &self.pci
    }
    pub fn minor(&self) -> &str {
        &self.minor
    }
    pub fn model(&self) -> &str {
        &self.model
    }
    /// `_catalogue` canonicalizes just this field before its independent fresh
    /// physical lookup. It does not validate coordinates in unrelated rows.
    pub fn catalogue_uuid(raw: &str) -> Result<super::GpuDeviceUuid> {
        let fields = fields(raw);
        let identity = trim_text(fields.get("GPU UUID").copied().unwrap_or(""));
        let tail = identity.strip_prefix("GPU-").unwrap_or(identity);
        super::GpuDeviceUuid::parse(&format!("GPU-{}", python_lowercase_string(tail)))
    }
}
fn fields(raw: &str) -> BTreeMap<&str, &str> {
    raw.split([
        '\n', '\r', '\u{b}', '\u{c}', '\u{1c}', '\u{1d}', '\u{1e}', '\u{85}', '\u{2028}',
        '\u{2029}',
    ])
    .filter_map(|line| line.split_once(':'))
    .collect()
}
fn pci_valid(value: &str) -> bool {
    let raw = value.as_bytes();
    raw.len() == 12
        && raw.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b':',
            10 => *byte == b'.',
            11 => matches!(byte, b'0'..=b'7'),
            _ => byte.is_ascii_hexdigit(),
        })
}
