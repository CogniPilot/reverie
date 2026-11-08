use super::*;
pub(super) fn decode(value: &Value) -> Result<ResourceRequestSelection> {
    closed(
        value,
        &[
            "employeeId",
            "draftId",
            "operationId",
            "reservationId",
            "targetSid",
            "profileVersion",
            "profileDigest",
            "previewDigest",
            "ramPolicyDigest",
        ],
    )?;
    Ok(ResourceRequestSelection::Apply {
        employee_id: employee(field(value, "employeeId")?)?,
        draft_id: identifier(field(value, "draftId")?)?,
        operation_id: identifier(field(value, "operationId")?)?,
        reservation_id: identifier(field(value, "reservationId")?)?,
        target_sid: ProfileSessionId::parse(identifier(field(value, "targetSid")?)?.as_str())
            .map_err(|_| ResourceActorDataError("RESOURCE_RAM_UUID"))?,
        profile_version: version(field(value, "profileVersion")?)?,
        profile_digest: digest(field(value, "profileDigest")?)?,
        preview_digest: digest(field(value, "previewDigest")?)?,
        ram_policy_digest: digest(field(value, "ramPolicyDigest")?)?,
    })
}
fn version(value: &Value) -> Result<ProfileVersion> {
    let number = match &value.0 {
        Node::String(value) => crate::rootless::parse_python_integer(&value.0)
            .and_then(|(negative, magnitude)| (!negative).then(|| magnitude.to_u64()).flatten()),
        Node::Number(Number::Integer(value)) => value.parse().ok(),
        Node::Number(Number::Float(value)) if value.is_finite() && *value >= 1.0 => {
            format!("{:.0}", value.trunc()).parse().ok()
        }
        Node::Bool(true) => Some(1),
        _ => None,
    }
    .ok_or(ResourceActorDataError("RESOURCE_RAM_PROFILE_VERSION"))?;
    ProfileVersion::try_new(number)
        .map_err(|_| ResourceActorDataError("RESOURCE_RAM_PROFILE_VERSION"))
}
