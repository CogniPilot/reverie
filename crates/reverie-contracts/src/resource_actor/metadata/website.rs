//! WebsiteFacts._item metadata comparisons only. No kernel/process observation,
//! immutable program custody, current owner or maintenance authority is minted.
use super::*;
mod mounts;
mod security;
#[cfg(test)]
mod tests;
const FULL_SPEC: &str = "WEBSITE_FULL_SPEC_CHANGED";

/// A PID declared by fully matching engine metadata, still only DATA. The
/// native caller must independently pin/inspect the actual process and peer.
pub struct QualifiedWebsiteMetadata {
    pid: UnsignedInteger,
}
impl QualifiedWebsiteMetadata {
    pub fn pid(&self) -> &UnsignedInteger {
        &self.pid
    }
}
impl EngineMetadata {
    pub fn qualify_website(&self, selected: &WebsiteSelection) -> Result<QualifiedWebsiteMetadata> {
        let pid = header(&self.0, selected)?;
        need(
            digest(required(&self.0, "Config")?)? == selected.config_digest,
            FULL_SPEC,
        )?;
        let host = host_config(required(&self.0, "HostConfig")?)?;
        need(digest(&host)? == selected.host_config_digest, FULL_SPEC)?;
        let mounts = mounts::normalize(required(&self.0, "Mounts")?)?;
        need(digest(&mounts)? == selected.mounts_digest, FULL_SPEC)?;
        security::check(&self.0, &mounts)?;
        Ok(QualifiedWebsiteMetadata { pid })
    }
}
fn required<'a>(value: &'a Value, name: &str) -> Result<&'a Value> {
    field(value, name).map_err(|_| ResourceActorDataError(FULL_SPEC))
}
fn matches_text(value: &Value, expected: &str) -> bool {
    matches!(&value.0, Node::String(text) if text.0.iter().copied().eq(expected.chars().map(u32::from)))
}
fn header(value: &Value, selected: &WebsiteSelection) -> Result<UnsignedInteger> {
    need(
        matches_text(required(value, "Id")?, selected.container.as_str())
            && matches_text(required(value, "Image")?, &selected.image),
        FULL_SPEC,
    )?;
    let state = required(value, "State")?;
    need(
        matches!(required(state, "Running")?.0, Node::Bool(true)),
        FULL_SPEC,
    )?;
    let pid = unsigned(required(state, "Pid")?).map_err(|_| ResourceActorDataError(FULL_SPEC))?;
    need(!pid.is_zero() && pid.as_str() != "1", FULL_SPEC)?;
    need(
        matches_text(
            required(required(value, "Config")?, "User")?,
            &format!("{}:{}", selected.uid, selected.gid),
        ),
        FULL_SPEC,
    )?;
    Ok(pid)
}
fn digest(value: &Value) -> Result<JournalDigest> {
    let bytes = crate::reservation_control::fingerprint(value)
        .map_err(|_| ResourceActorDataError(FULL_SPEC))?;
    Ok(JournalDigest::parse(&crate::digest::hex(&bytes)).expect("SHA256 digest"))
}
fn host_config(value: &Value) -> Result<Value> {
    const CODE: &str = "OOM_KILLER_MUST_REMAIN_ENABLED";
    let fields = object(value).map_err(|_| ResourceActorDataError(CODE))?;
    need(
        fields
            .get(&key("OomKillDisable"))
            .is_some_and(|value| matches!(value.0, Node::Null | Node::Bool(false))),
        CODE,
    )?;
    let mut normalized: BTreeMap<_, _> = fields
        .iter()
        .map(|(key, value)| (key.clone(), value.deep_clone()))
        .collect();
    normalized.insert(key("OomKillDisable"), Value(Node::Bool(false)));
    Ok(Value(Node::Object(normalized)))
}
