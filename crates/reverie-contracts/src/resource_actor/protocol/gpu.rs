//! Closed GPU selection and queue reply on the authenticated website channel.
use super::*;
use reverie_core::gpu_access::GpuStatusData;

pub(super) fn status(value: &Value) -> Result<ResourceRequestSelection> {
    closed(
        value,
        &["kind", "requestId", "verb", "employeeId", "sessionId"],
    )?;
    let session = identifier(field(value, "sessionId")?)?;
    Ok(ResourceRequestSelection::GpuStatus {
        employee_id: employee(field(value, "employeeId")?)?,
        session_id: ProfileSessionId::parse(session.as_str())
            .map_err(|_| ResourceActorDataError("GPU_CURRENT_SESSION"))?,
    })
}
pub(super) fn request(value: &Value) -> Result<(ResourceRequestSelection, Option<Value>)> {
    closed(
        value,
        &["kind", "requestId", "verb", "employeeId", "approval"],
    )?;
    let approved = field(value, "approval")?;
    Ok((
        ResourceRequestSelection::GpuRequest {
            employee_id: employee(field(value, "employeeId")?)?,
            intent: decode_intent(approved)?,
        },
        Some(approved.deep_clone()),
    ))
}
fn decode_intent(approved: &Value) -> Result<GpuIntent> {
    crate::gpu_access::decode_website_intent(approved)
        .map_err(|error| ResourceActorDataError(error.code()))
}
impl ResourceOperationRequest {
    pub(super) fn require_gpu_intent_echo(&self, approved: &Value) -> Result<()> {
        if let ResourceRequestSelection::GpuRequest { intent, .. } = self.selection() {
            need(
                decode_intent(approved)? == *intent,
                "GPU_OWNER_REQUEST_CHANGED",
            )?;
        }
        Ok(())
    }
    pub fn gpu_result_reply(&self, data: &GpuStatusData) -> Result<HumanFrame> {
        need(
            matches!(
                self.selection(),
                ResourceRequestSelection::GpuStatus { .. }
                    | ResourceRequestSelection::GpuRequest { .. }
            ) && data.employee().as_str() == self.employee_id().as_str(),
            "GPU_RESULT_BINDING_CHANGED",
        )?;
        let value =
            HumanFrame::decode(&crate::gpu_access::encode_status(data)).map_err(frame_error)?;
        self.result_reply(value.value().deep_clone())
    }
}
