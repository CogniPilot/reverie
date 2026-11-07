//! Purpose-only CDI interpretation. YAML is not coerced into JSON: safe typed
//! ignored values are validated too, and duplicate/non-string keys/aliases
//! refuse globally. This is host policy DATA, never a device entitlement.
mod json;
mod scalar;
mod yaml;
mod yaml_text;
use super::*;
use crate::{legacy_json, storage_identity::MetadataText};
use reverie_core::{PythonText, device_policy::NvidiaCdiDevice};
use std::collections::BTreeSet;

enum CdiValue {
    Atom,
    Text(MetadataText),
    Bytes(usize),
    List(Vec<usize>),
    Tuple(Vec<usize>),
    Map(BTreeMap<MetadataText, usize>),
    Set(BTreeSet<MetadataText>),
}
/// Flat nodes avoid adding a recursive destruction limit to captured policy.
pub struct CdiDocument {
    nodes: Vec<CdiValue>,
    root: usize,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CdiSelectedEdits {
    numeric_nodes: Vec<MetadataText>,
    mounts: usize,
    readonly: bool,
    hooks: usize,
}
impl CdiSelectedEdits {
    pub fn numeric_nodes(&self) -> &[MetadataText] {
        &self.numeric_nodes
    }
    pub fn mount_count(&self) -> usize {
        self.mounts
    }
    pub fn all_mounts_readonly(&self) -> bool {
        self.readonly
    }
    pub fn hook_count(&self) -> usize {
        self.hooks
    }
}
impl CdiDocument {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        // bytes.lstrip() has the six ASCII whitespace bytes, not Unicode trim.
        if raw
            .iter()
            .copied()
            .find(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c))
            == Some(b'{')
        {
            let value =
                legacy_json::decode_strict_bytes(raw).map_err(|_| GpuDataError::CdiDocument)?;
            Ok(Self::json(value))
        } else {
            yaml::decode(raw)
        }
    }
    fn json(value: Value) -> Self {
        json::document(value)
    }
    fn map(&self, index: usize) -> Result<&BTreeMap<MetadataText, usize>> {
        if let CdiValue::Map(value) = &self.nodes[index] {
            Ok(value)
        } else {
            Err(GpuDataError::CdiDocument)
        }
    }
    fn field(&self, index: usize, name: &str) -> Result<Option<usize>> {
        Ok(self
            .map(index)?
            .get(&MetadataText::from_scalar_text(name))
            .copied())
    }
    fn text(&self, index: usize) -> Option<&MetadataText> {
        if let CdiValue::Text(value) = &self.nodes[index] {
            Some(value)
        } else {
            None
        }
    }
    pub fn selected(&self, device: &NvidiaCdiDevice) -> Result<Option<CdiSelectedEdits>> {
        let rows = self
            .field(self.root, "devices")?
            .ok_or(GpuDataError::CdiDocument)?;
        let CdiValue::List(rows) = &self.nodes[rows] else {
            return Err(GpuDataError::CdiDocument);
        };
        if rows.len() > 256 {
            return Err(GpuDataError::CdiDocument);
        }
        if !self
            .field(self.root, "kind")?
            .and_then(|index| self.text(index))
            .is_some_and(|value| value.as_python_text_ref() == "nvidia.com/gpu")
        {
            return Ok(None);
        }
        let mut names = BTreeSet::new();
        let mut selected = None;
        for &row in rows {
            let name = self
                .field(row, "name")?
                .and_then(|index| self.text(index))
                .ok_or(GpuDataError::CdiDocument)?;
            let lower = PythonText::from_text_ref(name.as_python_text_ref()).lowercase();
            if !names.insert(lower) {
                return Err(GpuDataError::CdiDocument);
            }
            if name
                .scalar_text()
                .is_some_and(|name| format!("nvidia.com/gpu={name}") == device.as_str())
            {
                selected = Some(self.edits(row)?);
            }
        }
        Ok(selected)
    }
    fn combined(&self, row: usize, name: &str) -> Result<Vec<Option<usize>>> {
        let mut values = Vec::new();
        for parent in [self.root, row] {
            if let Some(edits) = self.field(parent, "containerEdits")?
                && let Some(index) = self.field(edits, name)?
            {
                values.extend(self.iterable(index)?);
            }
        }
        Ok(values)
    }
    fn iterable(&self, index: usize) -> Result<Vec<Option<usize>>> {
        match &self.nodes[index] {
            CdiValue::List(values) | CdiValue::Tuple(values) => {
                Ok(values.iter().copied().map(Some).collect())
            }
            CdiValue::Map(values) => Ok(vec![None; values.len()]),
            CdiValue::Set(values) => Ok(vec![None; values.len()]),
            CdiValue::Text(value) => Ok(vec![None; value.codepoints().len()]),
            CdiValue::Bytes(value) => Ok(vec![None; *value]),
            _ => Err(GpuDataError::CdiDocument),
        }
    }
    fn edits(&self, row: usize) -> Result<CdiSelectedEdits> {
        let mounts = self.combined(row, "mounts")?;
        let nodes = self.combined(row, "deviceNodes")?;
        let hooks = self.hook_count(row)?;
        if mounts.len() > 256 || nodes.len() > 64 || hooks > 32 {
            return Err(GpuDataError::CdiDocument);
        }
        let mut readonly = true;
        for &mount in &mounts {
            if !readonly {
                break;
            }
            let mount = mount.ok_or(GpuDataError::CdiDocument)?;
            readonly = match self.field(mount, "options")? {
                None => false,
                Some(index) => self.contains_ro(index)?,
            };
        }
        let mut numeric_nodes = Vec::new();
        for node in nodes {
            let node = node.ok_or(GpuDataError::CdiDocument)?;
            if let Some(path) = self.field(node, "path")?.and_then(|index| self.text(index))
                && path.scalar_text().is_some_and(|value| numeric_node(&value))
            {
                numeric_nodes.push(path.clone());
            }
        }
        Ok(CdiSelectedEdits {
            numeric_nodes,
            mounts: mounts.len(),
            readonly,
            hooks,
        })
    }
    fn contains_ro(&self, index: usize) -> Result<bool> {
        let ro = MetadataText::from_scalar_text("ro");
        match &self.nodes[index] {
            CdiValue::Text(value) => {
                Ok(value.codepoints().windows(2).any(|pair| pair == [114, 111]))
            }
            CdiValue::Map(value) => Ok(value.contains_key(&ro)),
            CdiValue::Set(value) => Ok(value.contains(&ro)),
            CdiValue::List(values) | CdiValue::Tuple(values) => {
                Ok(values.iter().any(|&index| self.text(index) == Some(&ro)))
            }
            _ => Err(GpuDataError::CdiDocument),
        }
    }
    fn hook_count(&self, row: usize) -> Result<usize> {
        let mut count = 0;
        for parent in [self.root, row] {
            if let Some(edits) = self.field(parent, "containerEdits")?
                && let Some(index) = self.field(edits, "hooks")?
            {
                count += match &self.nodes[index] {
                    CdiValue::Text(value) => value.codepoints().len(),
                    CdiValue::Map(values) => values.len(),
                    CdiValue::Set(values) => values.len(),
                    CdiValue::Bytes(value) => *value,
                    CdiValue::List(values) | CdiValue::Tuple(values) => values.len(),
                    _ => return Err(GpuDataError::CdiDocument),
                };
            }
        }
        Ok(count)
    }
}
fn numeric_node(value: &str) -> bool {
    value
        .strip_prefix("/dev/nvidia")
        .is_some_and(|tail| !tail.is_empty() && tail.bytes().all(|byte| byte.is_ascii_digit()))
}
