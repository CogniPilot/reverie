//! Preserve every original configuration byte around the ONE fixed insertion.
use super::*;
pub(super) fn insert_selector(raw: &[u8], path: &PosixPath) -> SetupResult<Vec<u8>> {
    let end = raw
        .iter()
        .rposition(|byte| !matches!(*byte, b' ' | b'\n' | b'\r' | b'\t'))
        .filter(|index| raw[*index] == b'}')
        .ok_or(ActorSetupDataError::Refused(
            "ACTOR_SETUP_CONFIGURATION_ENCODING",
        ))?;
    let mut bytes = raw[..end].to_vec();
    bytes.extend_from_slice(b",\"resourceActorConfig\":");
    bytes.extend(worker_config::compact_data(&Value(Node::String(Text(
        path.codepoints().to_vec(),
    )))));
    bytes.extend_from_slice(&raw[end..]);
    Ok(bytes)
}
