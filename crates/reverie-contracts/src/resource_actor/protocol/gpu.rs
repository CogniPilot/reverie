//! Closed GPU selection and queue reply on the authenticated website channel.
use super::*;
use reverie_core::gpu_access::GpuStatusData;

pub(super) fn status(value: &Value) -> Result<ResourceRequestSelection> {
    let (employee_id, session_id) = status_fields(value)?;
    Ok(ResourceRequestSelection::GpuStatus {
        employee_id,
        session_id,
    })
}
pub(super) fn apply_status(value: &Value) -> Result<ResourceRequestSelection> {
    let (employee_id, session_id) = status_fields(value)?;
    Ok(ResourceRequestSelection::GpuApplyStatus {
        employee_id,
        session_id,
    })
}
fn status_fields(value: &Value) -> Result<(ProfileEmployeeId, ProfileSessionId)> {
    closed(
        value,
        &["kind", "requestId", "verb", "employeeId", "sessionId"],
    )?;
    let session = identifier(field(value, "sessionId")?)?;
    Ok((
        employee(field(value, "employeeId")?)?,
        ProfileSessionId::parse(session.as_str())
            .map_err(|_| ResourceActorDataError("GPU_CURRENT_SESSION"))?,
    ))
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
pub(super) fn apply(value: &Value) -> Result<(ResourceRequestSelection, Option<Value>)> {
    closed(
        value,
        &["kind", "requestId", "verb", "employeeId", "approval"],
    )?;
    let approved = field(value, "approval")?;
    Ok((
        ResourceRequestSelection::GpuApply {
            employee_id: employee(field(value, "employeeId")?)?,
            queued: decode_queued(approved)?,
        },
        Some(approved.deep_clone()),
    ))
}
fn decode_queued(approved: &Value) -> Result<GpuQueuedRequest> {
    crate::gpu_access::decode_queued_approval(approved)
        .map_err(|error| ResourceActorDataError(error.code()))
}
fn decode_intent(approved: &Value) -> Result<GpuIntent> {
    crate::gpu_access::decode_website_intent(approved)
        .map_err(|error| ResourceActorDataError(error.code()))
}
impl ResourceOperationRequest {
    pub(super) fn require_gpu_intent_echo(&self, approved: &Value) -> Result<()> {
        match self.selection() {
            ResourceRequestSelection::GpuRequest { intent, .. } => need(
                decode_intent(approved)? == *intent,
                "GPU_OWNER_REQUEST_CHANGED",
            ),
            ResourceRequestSelection::GpuApply { queued, .. } => need(
                decode_queued(approved)? == *queued,
                "GPU_OWNER_REQUEST_CHANGED",
            ),
            _ => Ok(()),
        }
    }
    pub fn gpu_result_reply(&self, data: &GpuStatusData, can_apply: bool) -> Result<HumanFrame> {
        need(
            matches!(
                self.selection(),
                ResourceRequestSelection::GpuStatus { .. }
                    | ResourceRequestSelection::GpuApplyStatus { .. }
                    | ResourceRequestSelection::GpuRequest { .. }
                    | ResourceRequestSelection::GpuApply { .. }
            ) && data.employee().as_str() == self.employee_id().as_str(),
            "GPU_RESULT_BINDING_CHANGED",
        )?;
        let value =
            HumanFrame::decode(&crate::gpu_access::encode_status(data)).map_err(frame_error)?;
        if !matches!(
            self.selection(),
            ResourceRequestSelection::GpuApplyStatus { .. }
        ) {
            return self.result_reply(value.value().deep_clone());
        }
        let Node::Object(fields) = &value.value().0 else {
            return Err(ResourceActorDataError("GPU_RESULT_BINDING_CHANGED"));
        };
        let mut fields = fields
            .iter()
            .map(|(key, value)| (key.clone(), value.deep_clone()))
            .collect::<BTreeMap<_, _>>();
        fields.insert(key("canApply"), Value(Node::Bool(can_apply)));
        self.result_reply(Value(Node::Object(fields)))
    }
}
