use super::*;
use crate::{legacy_json, storage_identity::MetadataText};
/// Complete captured fixed `info --format` DATA, retaining unknown fields and
/// ordinary last-key-wins/nonfinite Python-str JSON equality for the recheck.
pub struct GpuEngineInformation(Value);
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
