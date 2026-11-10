//! Lossless option meaning for the two fixed ephemeral mount requests only.
use super::*;

const INVALID: &str = "DEPLOYMENT_EPHEMERAL_OPTIONS_CHANGED";
pub(in crate::model) fn normalize(value: &Value) -> Result<Value> {
    let fields = value
        .as_object()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    require(
        fields.len() == 2 && fields.contains_key("/tmp") && fields.contains_key("/run"),
        INVALID,
    )?;
    Ok(json!({"/tmp":row(&fields["/tmp"])?,"/run":row(&fields["/run"])?}))
}
pub(super) fn row(value: &Value) -> Result<Value> {
    let text = value
        .as_str()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    let mut fields = serde_json::Map::new();
    for part in text.split(',') {
        let (key, value) = match part.split_once('=') {
            Some(("size", value)) => ("size", json!(size(value)?)),
            Some(("mode", value)) => ("mode", json!(number(value, 8)?)),
            Some((key @ ("uid" | "gid"), value)) => (key, json!(number(value, 10)?)),
            None if matches!(part, "rw" | "nosuid" | "nodev" | "noexec") => (part, json!(true)),
            _ => return Err(DeploymentError::new(INVALID)),
        };
        require(fields.insert(key.into(), value).is_none(), INVALID)?;
    }
    Ok(Value::Object(fields))
}
fn number(value: &str, radix: u32) -> Result<u64> {
    require(
        !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()),
        INVALID,
    )?;
    u64::from_str_radix(value, radix).map_err(|_| DeploymentError::new(INVALID))
}
fn size(value: &str) -> Result<u64> {
    let (digits, factor) = match value.as_bytes().last() {
        Some(b'k' | b'K') => (&value[..value.len() - 1], 1024_u64),
        Some(b'm' | b'M') => (&value[..value.len() - 1], 1024_u64.pow(2)),
        Some(b'g' | b'G') => (&value[..value.len() - 1], 1024_u64.pow(3)),
        _ => (value, 1),
    };
    number(digits, 10)?
        .checked_mul(factor)
        .ok_or_else(|| DeploymentError::new(INVALID))
}
