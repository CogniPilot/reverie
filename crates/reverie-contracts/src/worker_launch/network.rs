//! The original optional network-inspect success branch. Labels remain DATA.
use super::*;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetworkDataError {
    Json,
    Structure,
    Ownership,
}
impl fmt::Display for NetworkDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Json => "WORKER_NETWORK_JSON",
            Self::Structure => "WORKER_NETWORK_STRUCTURE",
            Self::Ownership => "WORKER_NETWORK_OWNERSHIP",
        })
    }
}
impl std::error::Error for NetworkDataError {}
pub fn assert_network_labels(
    stdout: &[u8],
    deployment: &str,
    session: &reverie_core::ids::ProfileSessionId,
) -> std::result::Result<(), NetworkDataError> {
    let value =
        crate::legacy_json::decode_python_str(stdout).map_err(|_| NetworkDataError::Json)?;
    let Node::Array(rows) = &value.0 else {
        return Err(NetworkDataError::Structure);
    };
    let Some(Value(Node::Object(row))) = rows.first() else {
        return Err(NetworkDataError::Structure);
    };
    let labels = field(row, "Labels");
    let labels = if crate::legacy_json::truthy(labels) {
        let Some(Value(Node::Object(labels))) = labels else {
            return Err(NetworkDataError::Structure);
        };
        Some(labels)
    } else {
        None
    };
    let label = |name: &str, expected: &str| matches!(labels.and_then(|values|field(values,name)),Some(Value(Node::String(value))) if value.equals_ascii(expected));
    if label("reverie.session", session.as_str()) && label("reverie.worker", deployment) {
        Ok(())
    } else {
        Err(NetworkDataError::Ownership)
    }
}
