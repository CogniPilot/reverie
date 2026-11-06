//! One route classifier, before any credential lookup or upstream connection.
use http::{Method, Request, StatusCode};
use hyper::body::Incoming;
pub(super) const MAX_BODY: usize = 8 * 1024 * 1024;
pub(super) enum Route {
    Forward { hooks: bool },
    OpsUnavailable,
    Unavailable,
    PlanDecision,
}
pub(super) struct RequestPolicy {
    pub(super) route: Route,
    pub(super) length: usize,
}
pub(super) fn classify(request: &Request<Incoming>) -> Result<RequestPolicy, StatusCode> {
    let uri = request.uri();
    if uri.scheme().is_some() || uri.authority().is_some() || !uri.path().starts_with("/api/") {
        return Err(StatusCode::FORBIDDEN);
    }
    if ![
        Method::GET,
        Method::POST,
        Method::PUT,
        Method::PATCH,
        Method::DELETE,
        Method::HEAD,
    ]
    .contains(request.method())
    {
        return Err(StatusCode::NOT_IMPLEMENTED);
    }
    let lengths = request.headers().get_all("content-length");
    let length = match lengths.iter().next() {
        Some(raw) => raw
            .to_str()
            .ok()
            .and_then(|raw| raw.parse::<usize>().ok())
            .ok_or(StatusCode::BAD_REQUEST)?,
        None => 0,
    };
    if length > MAX_BODY || request.headers().contains_key("transfer-encoding") {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let route = classify_route(request, length)?;
    Ok(RequestPolicy { route, length })
}
fn classify_route(request: &Request<Incoming>, length: usize) -> Result<Route, StatusCode> {
    let uri = request.uri();
    let path = uri.path();
    let lengths = request.headers().get_all("content-length");
    let post = request.method() == Method::POST;
    let exact_json = request
        .headers()
        .get("content-type")
        .is_some_and(|value| value == "application/json");
    let route = if namespace(path, "ops") {
        if path != "/api/ops"
            || !post
            || uri.query().is_some()
            || length > 16 * 1024
            || lengths.iter().count() > 1
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        Route::OpsUnavailable
    } else if namespace(path, "browser-jobs") {
        if path != "/api/browser-jobs"
            || !post
            || uri.query().is_some()
            || length > 1024
            || lengths.iter().count() != 1
            || !exact_json
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        Route::Unavailable
    } else if namespace(path, "host-actions") {
        if length > 16 * 1024 || uri.query().is_some() || lengths.iter().count() > 1 {
            return Err(StatusCode::BAD_REQUEST);
        }
        Route::Unavailable
    } else if path == "/api/command-telemetry/hands" {
        if !post || uri.query().is_some() || length > 512 || lengths.iter().count() != 1 {
            return Err(StatusCode::BAD_REQUEST);
        }
        Route::Unavailable
    } else {
        if [
            "goals",
            "goal-grants",
            "goal-unblock-proofs",
            "goal-metadata",
        ]
        .iter()
        .any(|name| namespace(path, name))
            || recovery(
                request.method(),
                request.uri().path_and_query().map_or("", |p| p.as_str()),
            )
        {
            return Err(StatusCode::FORBIDDEN);
        }
        // Retired capability exports never reach a private lookup or upstream.
        if plan_private(path) {
            return Err(StatusCode::FORBIDDEN);
        }
        if reverie_contracts::office_plan::is_plan_decision(path) {
            if length > 64 * 1024 {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            return Ok(Route::PlanDecision);
        }
        Route::Forward {
            hooks: matches!(path, "/api/hook-event" | "/api/status-telemetry"),
        }
    };
    Ok(route)
}
fn namespace(path: &str, name: &str) -> bool {
    path.strip_prefix("/api/")
        .and_then(|path| path.strip_prefix(name))
        .is_some_and(|tail| tail.is_empty() || tail.starts_with('/'))
}
fn recovery(method: &Method, target: &str) -> bool {
    if method != Method::POST {
        return false;
    }
    let path = target.strip_prefix("/api/company/employees/");
    if let Some(path) = path
        && let Some((sid, tail)) = path.split_once('/')
        && reverie_core::ids::ProfileSessionId::parse(sid).is_ok()
        && matches!(tail, "reconnect" | "reconnect/status")
    {
        return true;
    }
    let Some(path) = target.strip_prefix("/api/plans/moves/") else {
        return false;
    };
    if path == "force" {
        return true;
    }
    path.split_once('/').is_some_and(|(id, action)| {
        !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && matches!(action, "status" | "resolve" | "cancel")
    })
}
fn plan_private(path: &str) -> bool {
    let mut decoded = Vec::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(a), Some(b)) = (
                (bytes[index + 1] as char).to_digit(16),
                (bytes[index + 2] as char).to_digit(16),
            )
        {
            decoded.push((a * 16 + b) as u8);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    let Some(tail) = decoded.strip_prefix(b"/api/plans/requests/") else {
        return false;
    };
    tail.iter()
        .position(|&byte| byte == b'/')
        .is_some_and(|index| {
            index > 0 && matches!(&tail[index + 1..], b"credential" | b"credential/")
        })
}
pub(super) fn strip_request(name: &http::HeaderName) -> bool {
    matches!(
        name.as_str(),
        "authorization"
            | "cookie"
            | "x-reverie-service-token"
            | "x-reverie-parent-session"
            | "x-reverie-hook-secret"
            | "host"
            | "origin"
            | "connection"
            | "upgrade"
            | "transfer-encoding"
            | "content-length"
    ) || name.as_str().starts_with("x-reverie-goal-")
        || name.as_str().starts_with("x-reverie-recovery-")
}
