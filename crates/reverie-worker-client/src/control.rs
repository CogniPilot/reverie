//! One-shot native C transport. Endpoint/UID checks bind the private socket;
//! they do not attest its executable or grant permission for an operation.
use crate::{
    Error,
    frame::{Connection, MAX_FRAME},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant},
};

pub(crate) const LIMIT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug)]
pub enum Action {
    Status,
    ProviderHealth,
    StorageStatus,
    StopLaptops,
    QuiesceForDeployment,
}
impl Action {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::ProviderHealth => "provider-health",
            Self::StorageStatus => "storage-status",
            Self::StopLaptops => "stop-laptops",
            Self::QuiesceForDeployment => "quiesce-for-deployment",
        }
    }
}
/// Exact bounded UTF-8 broker payload, published only after checked closure.
/// Its contents remain DATA; transport success is not an operation grant.
#[derive(Debug)]
pub struct Reply {
    bytes: Vec<u8>,
}
impl Reply {
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Send once, without retries, within the original caller deadline and the
/// existing 120-second control limit. A failure never proves effect absence.
pub fn call(
    endpoint: &Path,
    action: Action,
    deadline: Instant,
) -> Result<Reply, crate::ControlError> {
    let now = Instant::now();
    if deadline <= now {
        return Err(Error::new("Private worker deadline exceeded"));
    }
    let mut connection = Connection::at(endpoint, Some(deadline.min(now + LIMIT)))?;
    let result = if matches!(action, Action::QuiesceForDeployment) {
        exchange_quiesce(&mut connection)
    } else {
        exchange(&mut connection, json!({"action": action.name()}))
    };
    connection.finish(result).map(|bytes| Reply { bytes })
}
/// A successful reply is only the original drained handoff, not stopped-unit,
/// native global closure or deployment permission. Never resend after failure.
pub(crate) fn exchange_quiesce(connection: &mut Connection) -> crate::Result<Vec<u8>> {
    connection.send(b'C', br#"{"action":"quiesce-for-deployment"}"#)?;
    let reply = connection.receive(MAX_FRAME)?;
    let value: Value = serde_json::from_slice(&reply.payload)?;
    if reply.kind != b'J'
        || !value.as_object().is_some_and(|fields| {
            fields.len() == 2
                && fields.get("action").and_then(Value::as_str) == Some("quiesce-for-deployment")
                && fields.get("success").and_then(Value::as_bool) == Some(true)
        })
    {
        return Err(Error::new("Deployment quiescence was not acknowledged"));
    }
    connection.validate_quiesced()?;
    Ok(reply.payload)
}
pub(crate) fn exchange(connection: &mut Connection, request: Value) -> crate::Result<Vec<u8>> {
    connection.send(b'C', &serde_json::to_vec(&request)?)?;
    let reply = connection.receive(MAX_FRAME)?;
    if reply.kind != b'J' {
        return Err(Error::new("Office power request failed"));
    }
    std::str::from_utf8(&reply.payload).map_err(|_| Error::new("Invalid worker response"))?;
    connection.validate()?;
    Ok(reply.payload)
}
