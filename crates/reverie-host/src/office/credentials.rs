//! Host-only credentials are reread for each forwarded request. These never
//! enter guest configuration, a reply body, tracing, or the public error text.
use super::{Company, OfficeError, Result, policy};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use http::{HeaderMap, HeaderValue};
use reverie_core::ids::ProfileSessionId;
pub(super) fn headers(
    company: &Company,
    session: &ProfileSessionId,
    supplied: &HeaderMap,
    hooks: bool,
    body: &[u8],
) -> Result<HeaderMap> {
    if hooks && !reverie_contracts::office_hook::session_matches(body, session) {
        return Err(OfficeError::Refused);
    }
    let mut headers = HeaderMap::new();
    for (key, value) in supplied {
        if !policy::strip_request(key) {
            headers.append(key, value.clone());
        }
    }
    let raw = crate::native::observe_with_ancestors(
        &company.root()?.join("console/.env"),
        1024 * 1024,
        |_| true,
    )
    .map_err(|_| OfficeError::Refused)?
    .bytes;
    let env = std::str::from_utf8(&raw).map_err(|_| OfficeError::Refused)?;
    let mut username = "admin";
    let mut password = None;
    for line in env.split([
        '\n', '\r', '\u{b}', '\u{c}', '\u{1c}', '\u{1d}', '\u{1e}', '\u{85}', '\u{2028}',
        '\u{2029}',
    ]) {
        if let Some((key, value)) = line.split_once('=') {
            match key {
                "REVERIE_USERNAME" => username = value,
                "REVERIE_PASSWORD" => password = Some(value),
                _ => (),
            }
        }
    }
    let password = password.ok_or(OfficeError::Refused)?;
    let credentials = STANDARD.encode(format!("{username}:{password}"));
    headers.insert("host", HeaderValue::from_static("localhost:3000"));
    headers.insert(
        "authorization",
        HeaderValue::from_str(&format!("Basic {credentials}")).map_err(|_| OfficeError::Refused)?,
    );
    headers.insert(
        "x-reverie-parent-session",
        HeaderValue::from_str(session.as_str()).map_err(|_| OfficeError::Refused)?,
    );
    headers.insert(
        "content-length",
        HeaderValue::from_str(&body.len().to_string()).map_err(|_| OfficeError::Refused)?,
    );
    if hooks {
        let raw = crate::native::observe_with_ancestors(
            &company.root()?.join("console/hook-secret"),
            64 * 1024,
            |_| true,
        )
        .map_err(|_| OfficeError::Refused)?
        .bytes;
        let secret = std::str::from_utf8(&raw).map_err(|_| OfficeError::Refused)?;
        let secret = reverie_core::PythonTextRef::from_scalar_text(secret)
            .trimmed()
            .scalar_text()
            .ok_or(OfficeError::Refused)?;
        headers.insert(
            "x-reverie-hook-secret",
            HeaderValue::from_str(&secret).map_err(|_| OfficeError::Refused)?,
        );
    }
    Ok(headers)
}
