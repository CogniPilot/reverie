//! Existing reservation control data. A READY string and stored inode numbers
//! do not establish native custody, held admission or owner/effect authority.
mod binding;
mod image;
use crate::{
    legacy_json::{Node, Text, Value},
    worker_config::EffectiveWorkerConfig,
};
pub use binding::{ControlBinding, ControlDirectory, ControlIdentity};
pub use image::{CurrentImageData, CurrentImageDataError, validate_current_image_bytes};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt};
type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, ControlDataError>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlDataError {
    BindingSchema,
    NotReady,
    DomainChanged,
    Fingerprint,
}
impl ControlDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::BindingSchema => "RESERVATION_BINDING_SCHEMA",
            Self::NotReady => "RESERVATION_CONTROL_NOT_READY",
            Self::DomainChanged => "RESERVATION_DOMAIN_CHANGED",
            Self::Fingerprint => "RESERVATION_DOMAIN_FINGERPRINT",
        }
    }
}
impl fmt::Display for ControlDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ControlDataError {}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlDomainDigest([u8; 32]);
impl ControlDomainDigest {
    pub fn to_hex(&self) -> String {
        crate::digest::hex(&self.0)
    }
}
/// Exact source `domain_digest`: omit only these thirteen top-level fields,
/// then compact sorted ASCII JSON with nonfinite refusal. No size policy is
/// borrowed from profile staging or from a general effective-worker hash.
pub fn domain_digest(config: &EffectiveWorkerConfig) -> Result<ControlDomainDigest> {
    let mut value = config.as_value().deep_clone();
    let Node::Object(fields) = &mut value.0 else {
        unreachable!("worker object invariant");
    };
    for name in [
        "budgetMode",
        "memoryMiB",
        "pidsLimit",
        "cpus",
        "poolMemoryMiB",
        "poolTasksMax",
        "sessionResources",
        "employeeResources",
        "employeeMemoryPolicies",
        "laptopSwapPoolMiB",
        "softLimitHelperSocket",
        "image",
        "browserJobPolicy",
    ] {
        fields.remove(&key(name));
    }
    if !value.is_finite() || !integer_strings_fit(&value) {
        return Err(ControlDataError::Fingerprint);
    }
    Ok(ControlDomainDigest(
        Sha256::digest(crate::worker_config::compact_data(&value)).into(),
    ))
}
fn integer_strings_fit(value: &Value) -> bool {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match &value.0 {
            Node::Number(crate::legacy_json::Number::Integer(value))
                if value.strip_prefix('-').unwrap_or(value).len()
                    > crate::legacy_json::DEFAULT_INT_MAX_DIGITS =>
            {
                return false;
            }
            Node::Array(values) => pending.extend(values),
            Node::Object(values) => pending.extend(values.values()),
            _ => {}
        }
    }
    true
}
fn key(name: &str) -> Text {
    Text(name.chars().map(u32::from).collect())
}
fn field<'a>(value: &'a Object, name: &str) -> Result<&'a Value> {
    value.get(&key(name)).ok_or(ControlDataError::BindingSchema)
}
fn object(value: &Value) -> Result<&Object> {
    if let Node::Object(fields) = &value.0 {
        Ok(fields)
    } else {
        Err(ControlDataError::BindingSchema)
    }
}
fn exact(value: &Object, names: &[&str]) -> Result<()> {
    if value.len() == names.len() && names.iter().all(|name| value.contains_key(&key(name))) {
        Ok(())
    } else {
        Err(ControlDataError::BindingSchema)
    }
}
fn string_is(value: &Value, expected: &str) -> bool {
    matches!(&value.0,Node::String(value) if value.0.iter().copied().eq(expected.chars().map(u32::from)))
}
