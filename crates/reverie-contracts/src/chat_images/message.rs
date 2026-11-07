use super::*;
use reverie_core::ids::ChatImageFileId;
/// Exact original message/file linkage before AND after binary transfer.
/// Extra API fields remain accepted; duplicate JSON fields retain last values.
pub fn message_file(raw: &[u8], scope: &ImageScope, file: &ChatImageFileId) -> Result<Raster> {
    let refused = || ImageDataError("message_or_file_refused");
    let root = legacy_json::decode_rootless_profile(raw).map_err(|_| refused())?;
    let root = object(&root, "message_or_file_refused")?;
    need(
        matches!(field(root, "success"), Some(Value(Node::Bool(true)))),
        "message_or_file_refused",
    )?;
    let data = object(
        field(root, "data").ok_or_else(refused)?,
        "message_or_file_refused",
    )?;
    let message = object(
        field(data, "message").ok_or_else(refused)?,
        "message_or_file_refused",
    )?;
    need(
        text(field(message, "id"), "message_or_file_refused")? == scope.message().as_str()
            && !legacy_json::truthy(field(message, "deleted")),
        "message_or_file_refused",
    )?;
    let Some(Value(Node::Array(attachments))) = field(message, "attachments") else {
        return Err(refused());
    };
    let mut found = None;
    for attachment in attachments {
        let Node::Object(fields) = &attachment.0 else {
            continue;
        };
        if matches!(field(fields,"id"),Some(Value(Node::String(value)))if value.equals_ascii(file.as_str()))
        {
            need(found.is_none(), "message_or_file_refused")?;
            found = Some(text(field(fields, "type"), "message_or_file_refused")?);
        }
    }
    found
        .as_deref()
        .and_then(Raster::from_mime)
        .ok_or_else(refused)
}
