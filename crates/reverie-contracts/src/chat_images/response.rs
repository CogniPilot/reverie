use super::*;
use reverie_core::{
    chat_images::{ImageFileName, LIFETIME_SECONDS, MAX_FILE_BYTES, PUBLIC_ROOT},
    ids::{ChatImageFileId, ProfileSessionId},
};
pub struct ReadyImage {
    file: ChatImageFileId,
    name: ImageFileName,
    bytes: usize,
    expires: u64,
}
impl ReadyImage {
    pub fn try_new(
        file: ChatImageFileId,
        name: ImageFileName,
        bytes: usize,
        expires: u64,
    ) -> Result<Self> {
        need(
            (1..=MAX_FILE_BYTES).contains(&bytes) && (1..=LIFETIME_SECONDS).contains(&expires),
            "write_unconfirmed",
        )?;
        Ok(Self {
            file,
            name,
            bytes,
            expires,
        })
    }
}
pub fn binding_response(session: &ProfileSessionId, digest: &ImageDigest) -> Vec<u8> {
    format!(
        "{{\"version\":1,\"status\":\"bound\",\"sessionId\":\"{session}\",\"generation\":\"{}\"}}",
        digest.as_str()
    )
    .into_bytes()
}
pub fn ready_response(scope: &ImageScope, files: &[ReadyImage]) -> Result<Vec<u8>> {
    need(
        files.len() == scope.files().len()
            && files
                .iter()
                .zip(scope.files())
                .all(|(file, id)| &file.file == id),
        "write_unconfirmed",
    )?;
    need(
        files.iter().map(|file| file.bytes).sum::<usize>()
            <= reverie_core::chat_images::MAX_REQUEST_BYTES,
        "request_limit",
    )?;
    let files = files.iter().map(|file| format!("{{\"fileId\":\"{}\",\"path\":\"{PUBLIC_ROOT}/{}\",\"bytes\":{},\"expiresInSeconds\":{}}}",file.file,file.name.as_str(),file.bytes,file.expires)).collect::<Vec<_>>().join(",");
    Ok(format!("{{\"version\":1,\"status\":\"ready\",\"generation\":\"{}\",\"sessionId\":\"{}\",\"roomId\":\"{}\",\"messageId\":\"{}\",\"files\":[{files}]}}",scope.generation().as_str(),scope.session(),scope.room(),scope.message()).into_bytes())
}
