use super::*;
use crate::{legacy_json, storage_identity::MetadataText};
/// Complete captured fixed `info --format` DATA, retaining unknown fields and
/// ordinary last-key-wins/nonfinite Python-str JSON equality for the recheck.
pub struct GpuEngineInformation(Value);
pub struct PreflightEndpoint(MetadataText);
pub struct PreflightEngineData {
    endpoint: PreflightEndpoint,
    information: GpuEngineInformation,
}
impl PreflightEndpoint {
    pub fn from_text(value: reverie_core::PythonText) -> Result<Self> {
        let prefix: Vec<_> = "unix:///".bytes().map(u32::from).collect();
        if !value.codepoints().starts_with(&prefix) {
            return Err(GpuDataError::NativeBinding);
        }
        Ok(Self(MetadataText::from_python_text(value)))
    }
    pub fn decode(raw: &[u8]) -> Result<Self> {
        let value = legacy_json::decode_loads_bytes(raw).map_err(|_| GpuDataError::Json)?;
        let Node::String(value) = &value.0 else {
            return Err(GpuDataError::NativeBinding);
        };
        Self::from_text(
            reverie_core::PythonText::try_new(value.0.clone()).expect("JSON codepoints"),
        )
    }
}
impl PreflightEngineData {
    pub fn new(endpoint: PreflightEndpoint, information: GpuEngineInformation) -> Self {
        Self {
            endpoint,
            information,
        }
    }
    pub(crate) fn value(&self) -> Result<Value> {
        let fields = object(&self.information.0).ok_or(GpuDataError::NativeBinding)?;
        Ok(Value(Node::Object(
            [
                (
                    key("endpoint"),
                    Value(Node::String(Text(self.endpoint.0.codepoints().to_vec()))),
                ),
                (
                    key("id"),
                    field(fields, "ID").map_or(Value(Node::Null), Value::deep_clone),
                ),
                (
                    key("version"),
                    field(fields, "ServerVersion").map_or(Value(Node::Null), Value::deep_clone),
                ),
            ]
            .into(),
        )))
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        let value = self.value()?;
        if !value.is_finite() {
            return Err(GpuDataError::Nonfinite);
        }
        Ok(crate::worker_config::encode_data(&value))
    }
}
impl GpuEngineInformation {
    /// Standalone preflight calls json.loads on raw subprocess bytes. Keep its
    /// BOM/UTF16/32 detection separate from the broker's decoded-str reader.
    pub fn decode_preflight(stdout: &[u8]) -> Result<Self> {
        Ok(Self(
            legacy_json::decode_loads_bytes(stdout).map_err(|_| GpuDataError::CdiDocument)?,
        ))
    }
    pub fn decode(stdout: &[u8]) -> Result<Self> {
        Ok(Self(
            legacy_json::decode_python_str(stdout).map_err(|_| GpuDataError::CdiDocument)?,
        ))
    }
    pub fn equivalent(&self, other: &Self) -> bool {
        self.0.python_eq(&other.0)
    }
    pub fn same_kernel(&self, release: &str) -> bool {
        let Some(fields) = object(&self.0) else {
            return false;
        };
        field(fields, "OSType").and_then(text).as_deref() == Some("linux")
            && field(fields, "KernelVersion").and_then(text).as_deref() == Some(release)
    }
    /// Check list shape/count now; individual path types are checked lazily in
    /// source order so an invalid later path cannot reorder earlier native I/O.
    pub fn cdi_directories(&self) -> Result<impl Iterator<Item = Result<MetadataText>> + '_> {
        let fields = object(&self.0).ok_or(GpuDataError::CdiDocument)?;
        let Some(Value(Node::Array(values))) = field(fields, "CDISpecDirs") else {
            return Err(GpuDataError::CdiDocument);
        };
        if !(1..=8).contains(&values.len()) {
            return Err(GpuDataError::CdiDocument);
        }
        Ok(values.iter().map(|value| {
            if let Node::String(value) = &value.0 {
                Ok(MetadataText::from_text(value.clone()))
            } else {
                Err(GpuDataError::CdiDocument)
            }
        }))
    }
}
