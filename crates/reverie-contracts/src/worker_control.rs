//! Closed legacy C subset. Decoding is DATA, never a stop permit.
pub enum WorkerControlRequest {
    StopLaptops,
    QuiesceForDeployment,
    Status,
    ProviderHealth,
    StorageStatus,
    PoolRecoveryStatus,
    UnsupportedStopAgent,
}

impl WorkerControlRequest {
    pub fn decode(raw: &[u8]) -> Result<Self, &'static str> {
        let frame =
            crate::human_protocol::HumanFrame::decode(raw).map_err(|_| "WORKER_CONTROL_REQUEST")?;
        let canonical = frame.canonical().map_err(|_| "WORKER_CONTROL_REQUEST")?;
        let value: serde_json::Value =
            serde_json::from_slice(&canonical).map_err(|_| "WORKER_CONTROL_REQUEST")?;
        let fields = value.as_object().ok_or("WORKER_CONTROL_UNSUPPORTED")?;
        match fields.get("action").and_then(serde_json::Value::as_str) {
            Some("stop-laptops") if fields.len() == 1 => Ok(Self::StopLaptops),
            Some("quiesce-for-deployment") if fields.len() == 1 => Ok(Self::QuiesceForDeployment),
            Some("status") if fields.len() == 1 => Ok(Self::Status),
            Some("provider-health") if fields.len() == 1 => Ok(Self::ProviderHealth),
            Some("storage-status") if fields.len() == 1 => Ok(Self::StorageStatus),
            Some("pool-recovery-status") if fields.len() == 1 => Ok(Self::PoolRecoveryStatus),
            Some("stop-agent") if stop_agent(fields) => Ok(Self::UnsupportedStopAgent),
            _ => Err("WORKER_CONTROL_UNSUPPORTED"),
        }
    }
}
fn stop_agent(fields: &serde_json::Map<String, serde_json::Value>) -> bool {
    fields
        .keys()
        .all(|key| matches!(key.as_str(), "action" | "sessionId" | "notAfter" | "fence"))
        && fields
            .get("sessionId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|sid| reverie_core::ids::ProfileSessionId::parse(sid).is_ok())
        && fields.get("notAfter").is_none_or(|value| {
            value
                .as_u64()
                .is_some_and(|value| value > 0 && value <= reverie_core::revision::JS_SAFE_MAX)
        })
        && fields.get("fence").is_none_or(|value| {
            fields.contains_key("notAfter")
                && value.as_str().is_some_and(|value| {
                    value.len() == 32
                        && value
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn storage_status_accepts_only_the_fixed_read_only_action() {
        assert!(WorkerControlRequest::decode(br#"{"action":"storage-status"}"#).is_ok());
        for raw in [
            br#"{"action":"storage-status","sessionId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}"#
                .as_slice(),
            br#"{"action":"storage-status","reconcile":true}"#,
            br#"{"action":"storage-status","caller":"owner"}"#,
        ] {
            assert!(WorkerControlRequest::decode(raw).is_err());
        }
    }
    #[test]
    fn closed_stop_subset_preserves_unimplemented_and_extra_field_refusals() {
        assert!(matches!(
            WorkerControlRequest::decode(br#"{"action":"stop-laptops"}"#),
            Ok(WorkerControlRequest::StopLaptops)
        ));
        for raw in [
            br#"{"action":"stop-agent"}"#.as_slice(),
            br#"{"action":"shutdown"}"#,
            br#"{"action":"stop-laptops","caller":"employee"}"#,
            br#"{"action":"stop-laptops","force":true}"#,
            br#"{"action":"stop-laptops","principal":{"personId":"owner"}}"#,
        ] {
            assert!(WorkerControlRequest::decode(raw).is_err());
        }
    }
}
