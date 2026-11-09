use super::*;
use reverie_core::ids::{ChatImageFileId, ChatMessageId, ChatRoomId, ProfileSessionId};
pub enum ImageRequest {
    Binding(ProfileSessionId),
    Materialize(ImageScope),
}
impl ImageRequest {
    pub fn session(&self) -> &ProfileSessionId {
        match self {
            Self::Binding(session) => session,
            Self::Materialize(scope) => scope.session(),
        }
    }
}
pub fn decode_request(raw: &[u8]) -> Result<ImageRequest> {
    need(raw.len() <= 4096, "invalid_request")?;
    // Source json.loads(bytes, object_pairs_hook=unique): byte-encoding
    // detection, default Python constants/integers, close-time duplicates.
    let value =
        legacy_json::decode_metadata_bytes(raw).map_err(|_| ImageDataError("invalid_request"))?;
    let fields = object(&value, "invalid_request")?;
    need(
        text(field(fields, "purpose"), "invalid_request")? == PURPOSE,
        "invalid_request",
    )?;
    let action = text(field(fields, "action"), "invalid_request")?;
    need(
        matches!(action.as_str(), "binding" | "materialize"),
        "invalid_request",
    )?;
    let expected = if action == "binding" {
        &["purpose", "action", "sessionId"][..]
    } else {
        &["purpose", "action", "sessionId", "request"][..]
    };
    need(closed(fields, expected), "invalid_request")?;
    let session = text(field(fields, "sessionId"), "invalid_request")?;
    let session =
        ProfileSessionId::parse(&session).map_err(|_| ImageDataError("invalid_request"))?;
    if action == "binding" {
        return Ok(ImageRequest::Binding(session));
    }
    let scope = scope(field(fields, "request").ok_or(ImageDataError("invalid_request"))?)?;
    need(scope.session() == &session, "invalid_identity")?;
    Ok(ImageRequest::Materialize(scope))
}
pub fn decode_scope(raw: &[u8]) -> Result<ImageScope> {
    let value =
        legacy_json::decode_metadata_bytes(raw).map_err(|_| ImageDataError("invalid_request"))?;
    scope(&value)
}
fn scope(value: &Value) -> Result<ImageScope> {
    let fields = object(value, "invalid_request")?;
    need(
        closed(
            fields,
            &[
                "version",
                "sessionId",
                "roomId",
                "messageId",
                "generation",
                "fileIds",
            ],
        ) && matches!(field(fields,"version"),Some(Value(Node::Number(Number::Integer(v))))if v=="1"),
        "invalid_request",
    )?;
    let session = ProfileSessionId::parse(&text(field(fields, "sessionId"), "invalid_identity")?)
        .map_err(|_| ImageDataError("invalid_identity"))?;
    let room = ChatRoomId::parse(&text(field(fields, "roomId"), "invalid_identity")?)
        .map_err(|_| ImageDataError("invalid_identity"))?;
    let message = ChatMessageId::parse(&text(field(fields, "messageId"), "invalid_identity")?)
        .map_err(|_| ImageDataError("invalid_identity"))?;
    let generation = ImageDigest::parse(&text(field(fields, "generation"), "invalid_generation")?)
        .ok_or(ImageDataError("invalid_generation"))?;
    let Some(Value(Node::Array(files))) = field(fields, "fileIds") else {
        return Err(ImageDataError("invalid_files"));
    };
    let files = files
        .iter()
        .map(|value| {
            ChatImageFileId::parse(&text(Some(value), "invalid_files")?)
                .map_err(|_| ImageDataError("invalid_files"))
        })
        .collect::<Result<Vec<_>>>()?;
    ImageScope::try_new(session, room, message, generation, files)
        .ok_or(ImageDataError("invalid_files"))
}
