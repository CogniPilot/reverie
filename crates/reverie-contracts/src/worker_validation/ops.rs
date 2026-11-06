//! Only the metadata read by ops_service.broker_binding_custody, not daemon
//! authentication, installed executable verification, keys or effect grants.
use super::*;
use crate::legacy_json::ordered::{OrderNode, OrderedValue};
use reverie_core::worker_options::OpsServiceId;

pub struct OpsBindingConfig(Value);
impl OpsBindingConfig {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        let value = decode(raw)?;
        let fields = object(&value).ok_or(WorkerValidationError::Ops)?;
        shape(
            fields,
            &[
                "version",
                "companyId",
                "companyFile",
                "brokerConfig",
                "stateDirectory",
                "socketDirectory",
                "requestKey",
                "engineBinary",
                "engineSocket",
                "engineConfigDirectory",
                "resources",
                "authorization",
                "packageManifest",
            ],
        )?;
        if integer(field(fields, "version"))? != 1 {
            return Err(WorkerValidationError::Ops);
        }
        OpsServiceId::parse(&scalar(field(fields, "companyId"))?)?;
        let resources = field(fields, "resources")
            .and_then(object)
            .ok_or(WorkerValidationError::Ops)?;
        if resources.is_empty()
            || resources.len() > 16
            || resources.keys().any(|name| {
                scalar_text(name).is_none_or(|name| OpsServiceId::parse(&name).is_err())
            })
        {
            return Err(WorkerValidationError::Ops);
        }
        for name in [
            "companyFile",
            "brokerConfig",
            "stateDirectory",
            "socketDirectory",
            "requestKey",
            "engineBinary",
            "engineSocket",
            "engineConfigDirectory",
            "packageManifest",
        ] {
            let value = text(field(fields, name))?;
            if value.0.first() != Some(&47) {
                return Err(WorkerValidationError::Ops);
            }
        }
        Ok(Self(value))
    }
    pub fn company_file(&self) -> Result<MetadataText> {
        self.path("companyFile")
    }
    pub fn protected_paths(&self) -> Result<[MetadataText; 3]> {
        Ok([
            self.path("stateDirectory")?,
            self.path("socketDirectory")?,
            self.path("requestKey")?,
        ])
    }
    pub fn authorization_path(&self) -> Result<Option<MetadataText>> {
        self.authorization()?
            .map(|fields| metadata(field(fields, "config")))
            .transpose()
    }
    /// Called after authorization principal-key checks, matching the original
    /// lazy read order rather than prevalidating dormant authorization fields.
    pub fn authorization_goal(&self) -> Result<MetadataText> {
        let fields = self.authorization()?.ok_or(WorkerValidationError::Ops)?;
        let value = field(fields, "goalPrivateConfig").ok_or(WorkerValidationError::Ops)?;
        if !crate::legacy_json::truthy(Some(value)) {
            return Err(WorkerValidationError::Ops);
        }
        metadata(Some(value))
    }
    fn authorization(&self) -> Result<Option<&Object>> {
        let fields = object(&self.0).expect("checked OPS object");
        match field(fields, "authorization") {
            Some(Value(Node::Null)) => Ok(None),
            Some(value) => object(value).map(Some).ok_or(WorkerValidationError::Ops),
            _ => Err(WorkerValidationError::Ops),
        }
    }
    fn path(&self, name: &str) -> Result<MetadataText> {
        metadata(field(object(&self.0).expect("checked OPS object"), name))
    }
}
pub struct OpsPrivateDocument(OrderedValue);
impl OpsPrivateDocument {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        Ok(Self(
            crate::legacy_json::decode_ops_private_bytes(raw)
                .map_err(|_| WorkerValidationError::Ops)?,
        ))
    }
    pub fn principal_count(&self) -> Result<usize> {
        let fields = object(&self.0.value).ok_or(WorkerValidationError::Ops)?;
        match field(fields, "principals") {
            Some(Value(Node::Array(values))) => Ok(values.len()),
            // Python permits empty iterables here; a nonempty object/string
            // yields a string principal and its ['key'] access then refuses.
            Some(Value(Node::Object(values))) if values.is_empty() => Ok(0),
            Some(Value(Node::String(value))) if value.0.is_empty() => Ok(0),
            _ => Err(WorkerValidationError::Ops),
        }
    }
    pub fn principal_key(&self, index: usize) -> Result<MetadataText> {
        let fields = object(&self.0.value).ok_or(WorkerValidationError::Ops)?;
        let Some(Value(Node::Array(values))) = field(fields, "principals") else {
            return Err(WorkerValidationError::Ops);
        };
        let value = values
            .get(index)
            .and_then(object)
            .ok_or(WorkerValidationError::Ops)?;
        metadata(field(value, "key"))
    }
    pub fn goal_hosts(&self) -> Result<impl Iterator<Item = Result<MetadataText>> + '_> {
        let fields = object(&self.0.value).ok_or(WorkerValidationError::Ops)?;
        let paths = field(fields, "paths")
            .and_then(object)
            .ok_or(WorkerValidationError::Ops)?;
        let index = self
            .0
            .root_child_index(&key("paths"))
            .ok_or(WorkerValidationError::Ops)?;
        let Some(OrderNode::Object(order)) = self.0.graph.nodes.get(index) else {
            return Err(WorkerValidationError::Ops);
        };
        Ok(order.iter().map(move |(name, _)| {
            let value = paths.get(name).ok_or(WorkerValidationError::Ops)?;
            metadata(field(
                object(value).ok_or(WorkerValidationError::Ops)?,
                "host",
            ))
        }))
    }
}
fn scalar_text(value: &Text) -> Option<String> {
    value.0.iter().map(|&c| char::from_u32(c)).collect()
}
fn decode(raw: &[u8]) -> Result<Value> {
    crate::legacy_json::decode_strict_bytes(raw).map_err(|_| WorkerValidationError::Ops)
}
