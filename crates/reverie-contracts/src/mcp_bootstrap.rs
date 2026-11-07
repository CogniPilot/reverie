//! Private fixed-launcher bootstrap DATA. Not an MCP tool/API request or grant.
use crate::memory_context::{self, ContextCodecError, ContextFingerprint};
use reverie_core::memory_context::{InstalledMemoryContext, McpOptions};
use serde::Serialize;

pub const MAX_BYTES: usize = 512 * 1024;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap<'a> {
    schema: &'static str,
    native_memory: &'a str,
    context: memory_context::Summary,
    options: Options<'a>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Options<'a> {
    url: Option<&'a str>,
    allow_any_session: bool,
    chat: bool,
}
pub fn encode(
    native_memory: &str,
    options: &McpOptions,
    context: Option<(&InstalledMemoryContext, &ContextFingerprint)>,
) -> Result<Vec<u8>, ContextCodecError> {
    let value = Bootstrap {
        schema: "reverie-installed-mcp-bootstrap-v1",
        native_memory,
        context: memory_context::summary(context),
        options: Options {
            url: options.url.as_deref(),
            allow_any_session: options.allow_any_session,
            chat: options.chat,
        },
    };
    let bytes = serde_json::to_vec(&value).map_err(|_| ContextCodecError)?;
    if bytes.len() > MAX_BYTES {
        return Err(ContextCodecError);
    }
    Ok(bytes)
}
