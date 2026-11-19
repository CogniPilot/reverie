use bytes::Bytes;
use http::{HeaderMap, Response, StatusCode, header};
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use std::io;

pub(crate) type Body = UnsyncBoxBody<Bytes, io::Error>;
pub(crate) type Reply = Response<Body>;

const CSP: &str = concat!(
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; ",
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; ",
    "media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; ",
    "object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
);

pub(crate) fn protect(headers: &mut HeaderMap) {
    for (name, value) in [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        ("strict-transport-security", "max-age=31536000"),
        ("content-security-policy", CSP),
        ("cross-origin-opener-policy", "same-origin"),
        ("cross-origin-embedder-policy", "require-corp"),
        ("cross-origin-resource-policy", "same-origin"),
        (
            "permissions-policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
        ),
        ("origin-agent-cluster", "?1"),
    ] {
        headers.insert(name, header::HeaderValue::from_static(value));
    }
}

pub(crate) fn status_reply(status: StatusCode) -> Reply {
    if !status.is_client_error() && !status.is_server_error() {
        return response(status, Bytes::new());
    }
    let reason = status.canonical_reason().unwrap_or("Preview refused");
    let mut out = response(
        status,
        format!("{status_code}: {reason}", status_code = status.as_u16()).into(),
    );
    out.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    out
}

pub(crate) fn json(status: StatusCode, value: impl serde::Serialize) -> Reply {
    let Ok(body) = serde_json::to_vec(&value) else {
        return status_reply(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let mut out = response(status, body.into());
    out.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    out
}

fn response(status: StatusCode, bytes: Bytes) -> Reply {
    let mut out = Response::new(payload(bytes));
    *out.status_mut() = status;
    out
}

pub(crate) fn payload(bytes: Bytes) -> Body {
    Full::new(bytes)
        .map_err(|never| match never {})
        .boxed_unsync()
}
