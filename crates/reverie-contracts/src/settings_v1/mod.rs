//! `GET /api/settings` as the TS route answers it: `readJsonConfig(SETTINGS_PATH, 'settings', {})`
//! returned from an async handler, then the server's `preSerialization` envelope and Fastify's send.
//! Any read or parse failure is the default `{}`; a top-level string goes out as text/plain; every
//! other result is JSON. Files over `MAX_FILE_BYTES` and nesting over `MAX_DEPTH` are refused (the
//! two declared bounds); everything below them is answered byte for byte as TS does.
use crate::js_json::{self, Object, ParseError, Value};
use std::sync::OnceLock;

pub const MAX_FILE_BYTES: usize = 1 << 20;
pub const MAX_DEPTH: usize = 1000;
pub const MAX_RESPONSE_BYTES: usize = 8 << 20;

/// TS's `ErrorStatus` table; a TS test asserts it equals the table in types/api.ts.
const ERROR_STATUS: &str = include_str!("error-status.json");
/// `String(({})[name])` for each `Object.prototype` name under the pinned Node; a TS test
/// regenerates and compares it.
const INHERITED_ERROR_CODES: &str = include_str!("inherited-error-codes.json");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContentType {
    Json,
    PlainText,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Response {
    pub status: u16,
    pub content_type: ContentType,
    pub body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refusal {
    RequestSchema,
    FileBound,
    DepthBound,
    ResponseBound,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::RequestSchema => "REQUEST_SCHEMA",
            Self::FileBound => "FILE_BOUND",
            Self::DepthBound => "DEPTH_BOUND",
            Self::ResponseBound => "RESPONSE_BOUND",
        }
    }
}

/// The path TS computed (`SETTINGS_PATH`); the handler derives no path of its own.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Request {
    pub settings_path: String,
}

/// `{"settingsPath": <string>}` and nothing else.
pub fn decode_request(raw: &[u8]) -> Result<Request, Refusal> {
    let text = std::str::from_utf8(raw).map_err(|_| Refusal::RequestSchema)?;
    let Ok(Value::Object(object)) = js_json::parse(text, 1) else {
        return Err(Refusal::RequestSchema);
    };
    match (object.len(), object.get("settingsPath")) {
        // Node encodes a path string's lone surrogates as U+FFFD; so does from_utf16_lossy.
        (1, Some(Value::String(path))) if !path.is_empty() => Ok(Request {
            settings_path: String::from_utf16_lossy(path),
        }),
        _ => Err(Refusal::RequestSchema),
    }
}

/// The route's answer for the file's bytes, or `None` when reading failed (any error: TS
/// answers its default for all of them).
pub fn respond(contents: Option<&[u8]>) -> Result<Response, Refusal> {
    let value = match contents {
        None => default(),
        Some(bytes) if bytes.len() > MAX_FILE_BYTES => return Err(Refusal::FileBound),
        // `readFile(path, 'utf-8')` decodes with U+FFFD for invalid sequences and keeps a BOM.
        Some(bytes) => match js_json::parse(&String::from_utf8_lossy(bytes), MAX_DEPTH) {
            Ok(value) => value,
            Err(ParseError::Syntax) => default(),
            Err(ParseError::Depth) => return Err(Refusal::DepthBound),
        },
    };
    let response = construct(&value);
    if response.body.len() > MAX_RESPONSE_BYTES {
        return Err(Refusal::ResponseBound);
    }
    Ok(response)
}

fn default() -> Value {
    Value::Object(Object::default())
}

/// The hook's branches in its order (server.ts preSerialization), then Fastify's send.
fn construct(value: &Value) -> Response {
    match value {
        // Fastify sends a string payload as text/plain, unchanged (Node encodes it as UTF-8).
        Value::String(units) => Response {
            status: 200,
            content_type: ContentType::PlainText,
            body: String::from_utf16_lossy(units).into_bytes(),
        },
        Value::Null | Value::Bool(_) | Value::Number(_) => json(200, text(value)),
        Value::Object(object) => match object.get("success") {
            Some(Value::Bool(false)) => failure(object, value),
            Some(Value::Bool(true)) => json(200, text(value)),
            // Every other `success` (absent, null, a number, a string, an array or an object).
            _ => wrapped(value),
        },
        Value::Array(_) => wrapped(value),
    }
}

/// `success: false`: the status comes from a string `errorCode`, otherwise it stays 200.
fn failure(object: &Object, value: &Value) -> Response {
    let Some(Value::String(code)) = object.get("errorCode") else {
        return json(200, text(value));
    };
    match error_status(code) {
        Status::Known(status) => json(status, text(value)),
        Status::Unknown => json(400, text(value)),
        Status::Inherited(error) => json(500, error),
    }
}

fn wrapped(value: &Value) -> Response {
    json(200, format!(r#"{{"success":true,"data":{}}}"#, text(value)))
}

fn json(status: u16, body: String) -> Response {
    Response {
        status,
        content_type: ContentType::Json,
        body: body.into_bytes(),
    }
}

fn text(value: &Value) -> String {
    let mut output = String::new();
    js_json::stringify(value, &mut output);
    output
}

enum Status {
    Known(u16),
    /// `ErrorStatus[code] ?? 400`, for a code that is neither own nor inherited.
    Unknown,
    /// An inherited `Object.prototype` name: `reply.code` throws on the non-number, and the route
    /// error handler answers 500 with this body; the hook then leaves it alone (status not 200).
    Inherited(String),
}

fn error_status(code: &[u16]) -> Status {
    let tables = tables();
    if let Some(Value::Number(status)) = lookup(&tables.statuses, code) {
        return Status::Known(*status as u16);
    }
    let Some(Value::String(error)) = lookup(&tables.inherited, code) else {
        return Status::Unknown;
    };
    let mut message = tables.prefix.clone();
    message.extend_from_slice(error);
    let mut body = String::from(r#"{"success":false,"error":"#);
    js_json::quote(&mut body, &message);
    body.push_str(r#","errorCode":"OPERATION_FAILED"}"#);
    Status::Inherited(body)
}

fn lookup<'a>(object: &'a Object, key: &[u16]) -> Option<&'a Value> {
    object
        .entries()
        .iter()
        .find(|(name, _)| name.as_slice() == key)
        .map(|(_, value)| value)
}

struct Tables {
    statuses: Object,
    prefix: Vec<u16>,
    inherited: Object,
}

/// The two fixtures, parsed once. They are compiled in and checked by tests, so a malformed one is
/// a build defect, not a request outcome.
fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let object = |text: &str| match js_json::parse(text, 3) {
            Ok(Value::Object(object)) => object,
            _ => panic!("a compiled-in settings fixture is not a JSON object"),
        };
        let inherited = object(INHERITED_ERROR_CODES);
        let field = |name: &str| inherited.get(name).cloned();
        let (Some(Value::String(prefix)), Some(Value::Object(names))) =
            (field("prefix"), field("names"))
        else {
            panic!("inherited-error-codes.json lacks its prefix or names");
        };
        Tables {
            statuses: object(ERROR_STATUS),
            prefix,
            inherited: names,
        }
    })
}

/// Every status this route can answer with: 200, 400, 500 and each ErrorStatus value.
pub fn statuses() -> Vec<u16> {
    let mut statuses: Vec<u16> = tables()
        .statuses
        .entries()
        .iter()
        .filter_map(|(_, value)| match value {
            Value::Number(status) => Some(*status as u16),
            _ => None,
        })
        .chain([200, 400, 500])
        .collect();
    statuses.sort_unstable();
    statuses.dedup();
    statuses
}

#[cfg(test)]
mod tests;
