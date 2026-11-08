//! Closed legacy C subset. Decoding is DATA, never a stop permit.
pub enum WorkerControlRequest {
    StopLaptops,
}

impl WorkerControlRequest {
    pub fn decode(raw: &[u8]) -> Result<Self, &'static str> {
        let frame =
            crate::human_protocol::HumanFrame::decode(raw).map_err(|_| "WORKER_CONTROL_REQUEST")?;
        let canonical = frame.canonical().map_err(|_| "WORKER_CONTROL_REQUEST")?;
        let value: serde_json::Value =
            serde_json::from_slice(&canonical).map_err(|_| "WORKER_CONTROL_REQUEST")?;
        if value.as_object().is_some_and(|fields| {
            fields.len() == 1
                && fields.get("action").and_then(serde_json::Value::as_str) == Some("stop-laptops")
        }) {
            Ok(Self::StopLaptops)
        } else {
            Err("WORKER_CONTROL_UNSUPPORTED")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
