//! Versioned session resources live inside the existing R-excluded map. A
//! selected null freezes absence; it must not fall through to a later EID policy.
use crate::{
    broker_resources::{self, ResourceConfigError},
    device_policy::memory,
    legacy_json::{Node, Number, Text, Value},
};
use reverie_core::device_policy::ProjectedMemoryPolicy;
use std::collections::BTreeMap;
type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, ResourceConfigError>;
pub(crate) struct SessionPolicy<'a> {
    pub(crate) resources: &'a Value,
    pub(crate) memory: Option<ProjectedMemoryPolicy>,
}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn object(value: &Value) -> Result<&Object> {
    match &value.0 {
        Node::Object(fields) => Ok(fields),
        _ => Err(ResourceConfigError::ResourceShape),
    }
}
pub(crate) fn decode(value: &Value) -> Result<Option<SessionPolicy<'_>>> {
    let fields = object(value)?;
    let Some(version) = fields.get(&key("version")) else {
        return Ok(None);
    };
    if !matches!(version, Value(Node::Number(Number::Integer(version))) if version == "2")
        || fields.len() != 3
    {
        return Err(ResourceConfigError::ResourceShape);
    }
    let resources = fields
        .get(&key("resources"))
        .ok_or(ResourceConfigError::ResourceShape)?;
    let resource_fields = object(resources)?;
    broker_resources::require_template_fields(resource_fields)?;
    let effective = broker_resources::template_fields(resource_fields)?.resolve(None)?;
    let memory = fields
        .get(&key("memoryPolicy"))
        .ok_or(ResourceConfigError::ResourceShape)?;
    let memory = if matches!(memory, Value(Node::Null)) {
        None
    } else {
        let mut fields: Object = object(memory)?
            .iter()
            .map(|(key, value)| (key.clone(), value.deep_clone()))
            .collect();
        let removed = fields.remove(&key("swapPoolMiB"));
        let Some(Value(Node::Number(Number::Integer(pool)))) = removed.as_ref() else {
            return Err(ResourceConfigError::ResourceShape);
        };
        let pool = pool
            .parse()
            .map_err(|_| ResourceConfigError::ResourceShape)?;
        let policy = memory::policy(&Value(Node::Object(fields)))
            .map_err(|_| ResourceConfigError::ResourceShape)?;
        Some(
            policy
                .project(pool, Some(&effective))
                .map_err(|_| ResourceConfigError::ResourceShape)?,
        )
    };
    Ok(Some(SessionPolicy { resources, memory }))
}
pub(crate) fn wrap(resources: Object, memory: Option<Value>) -> Value {
    Value(Node::Object(BTreeMap::from([
        (
            key("version"),
            Value(Node::Number(Number::Integer("2".to_owned()))),
        ),
        (key("resources"), Value(Node::Object(resources))),
        (key("memoryPolicy"), memory.unwrap_or(Value(Node::Null))),
    ])))
}
pub(crate) fn configured(config: &crate::worker_config::EffectiveWorkerConfig) -> bool {
    let Ok(fields) = object(config.as_value()) else {
        return false;
    };
    fields
        .get(&key("sessionResources"))
        .and_then(|value| object(value).ok())
        .is_some_and(|entries| {
            entries
                .values()
                .any(|value| object(value).is_ok_and(|entry| entry.contains_key(&key("version"))))
        })
}
