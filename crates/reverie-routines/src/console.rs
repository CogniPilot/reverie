//! The console calls R1 uses, and no others: sessions (list and one), input, the cron-job count, plan usage.
//!
//! Loopback HTTP only. No proxy can carry the token off the host, and no redirect is followed (F7: the token must
//! never follow one): any answer other than 2xx is an error.

use crate::json::{self, Json};
use crate::policy::is_session_id;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub const DEFAULT_URL: &str = "http://127.0.0.1:3001";
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY: usize = 4 << 20;

#[derive(Debug)]
pub enum ConsoleError {
    /// A non-2xx status.
    Status(u16),
    Other(String),
}

fn other<T>(message: impl Into<String>) -> Result<T, ConsoleError> {
    Err(ConsoleError::Other(message.into()))
}

pub struct Console {
    host: String,
    port: u16,
    pub token: Option<String>,
}

/// `http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?`, exactly.
fn parse_url(url: &str) -> Option<(String, u16)> {
    let rest = url.strip_prefix("http://")?;
    let (host, port) = match rest.split_once(':') {
        Some((h, p)) => {
            if p.is_empty() || p.len() > 5 || !p.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            // Python's pattern takes any 1-5 digits; a port beyond 65535 then fails to connect.
            (h, p.parse::<u32>().ok()?)
        }
        None => (rest, 80),
    };
    if host != "127.0.0.1" && host != "localhost" {
        return None;
    }
    Some((host.to_string(), u16::try_from(port).unwrap_or(0)))
}

/// One received response: status and body.
fn read_response(stream: &mut TcpStream) -> Result<(u16, Vec<u8>), ConsoleError> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    let head_end = loop {
        if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if raw.len() > 64 * 1024 {
            return other("response headers too large");
        }
        let n = stream
            .read(&mut buf)
            .map_err(|e| ConsoleError::Other(e.to_string()))?;
        if n == 0 {
            return other("connection closed before the response");
        }
        raw.extend_from_slice(&buf[..n]);
    };
    let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
    let mut body = raw[head_end + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| ConsoleError::Other("malformed status line".into()))?;
    let mut length = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse::<usize>().ok();
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            && value.eq_ignore_ascii_case("chunked")
        {
            chunked = true;
        }
    }
    // Read to the end of the connection (the request said Connection: close), never past the body bound.
    loop {
        if body.len() > MAX_BODY + 64 * 1024 || length.is_some_and(|l| !chunked && body.len() >= l)
        {
            break;
        }
        let n = stream
            .read(&mut buf)
            .map_err(|e| ConsoleError::Other(e.to_string()))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&buf[..n]);
    }
    if chunked {
        body = dechunk(&body)?;
    } else if let Some(l) = length {
        body.truncate(l);
    }
    Ok((status, body))
}

fn dechunk(mut data: &[u8]) -> Result<Vec<u8>, ConsoleError> {
    let mut out = Vec::new();
    loop {
        let Some(i) = data.windows(2).position(|w| w == b"\r\n") else {
            return other("malformed chunked body");
        };
        let size_text = String::from_utf8_lossy(&data[..i]).to_string();
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| ConsoleError::Other("malformed chunk size".into()))?;
        data = &data[i + 2..];
        if size == 0 {
            return Ok(out);
        }
        if data.len() < size {
            return other("truncated chunk");
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + 2..).unwrap_or(&[]);
    }
}

/// A header value http.client would send unchanged: printable ASCII and tab. Python refused CR and LF (except folded
/// continuations) and could not encode non-latin-1 text; this refuses every other byte too, before any connection.
fn valid_header_value(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b == b'\t' || (b' '..=b'~').contains(&b))
}

/// The JSON text of a reply, decoded as python's `json.loads(bytes)` decodes it: the encoding detected from a BOM or
/// from the zero bytes of its first characters (`json.detect_encoding`). Lone surrogates, which python passed through,
/// refuse here.
pub fn decode_json_bytes(raw: &[u8]) -> Result<String, ConsoleError> {
    let refuse = || ConsoleError::Other("console reply is not valid text".into());
    let utf16 = |b: &[u8], big: bool| -> Result<String, ConsoleError> {
        if !b.len().is_multiple_of(2) {
            return Err(refuse());
        }
        let units = b.chunks_exact(2).map(|c| {
            if big {
                u16::from_be_bytes([c[0], c[1]])
            } else {
                u16::from_le_bytes([c[0], c[1]])
            }
        });
        char::decode_utf16(units)
            .collect::<Result<String, _>>()
            .map_err(|_| refuse())
    };
    let utf32 = |b: &[u8], big: bool| -> Result<String, ConsoleError> {
        if !b.len().is_multiple_of(4) {
            return Err(refuse());
        }
        b.chunks_exact(4)
            .map(|c| {
                let n = if big {
                    u32::from_be_bytes([c[0], c[1], c[2], c[3]])
                } else {
                    u32::from_le_bytes([c[0], c[1], c[2], c[3]])
                };
                char::from_u32(n).ok_or_else(refuse)
            })
            .collect()
    };
    let utf8 = |b: &[u8]| String::from_utf8(b.to_vec()).map_err(|_| refuse());
    match raw {
        [0, 0, 0xFE, 0xFF, rest @ ..] => utf32(rest, true),
        [0xFF, 0xFE, 0, 0, rest @ ..] => utf32(rest, false),
        [0xFE, 0xFF, rest @ ..] => utf16(rest, true),
        [0xFF, 0xFE, rest @ ..] => utf16(rest, false),
        [0xEF, 0xBB, 0xBF, rest @ ..] => utf8(rest),
        [0, b1, ..] if raw.len() >= 4 => {
            if *b1 != 0 {
                utf16(raw, true)
            } else {
                utf32(raw, true)
            }
        }
        [_, 0, b2, b3, ..] => {
            if *b2 != 0 || *b3 != 0 {
                utf16(raw, false)
            } else {
                utf32(raw, false)
            }
        }
        [0, _] => utf16(raw, true),
        [_, 0] => utf16(raw, false),
        _ => utf8(raw),
    }
}

impl Console {
    pub fn new(url: &str, token: Option<String>) -> Option<Console> {
        let (host, port) = parse_url(url)?;
        Some(Console { host, port, token })
    }

    /// One call: the decoded `data` (or the whole value when it has none). `success: false` is a refusal.
    pub fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Json>,
    ) -> Result<Json, ConsoleError> {
        let token = self.token.as_deref().filter(|t| !t.is_empty());
        if token.is_some_and(|t| !valid_header_value(t)) {
            return other("invalid service token");
        }
        let address = (self.host.as_str(), self.port)
            .to_socket_addrs()
            .map_err(|e| ConsoleError::Other(e.to_string()))?
            .collect::<Vec<_>>();
        let mut stream = None;
        for a in &address {
            if let Ok(s) = TcpStream::connect_timeout(a, TIMEOUT) {
                stream = Some(s);
                break;
            }
        }
        let Some(mut stream) = stream else {
            return other("console unreachable");
        };
        stream
            .set_read_timeout(Some(TIMEOUT))
            .map_err(|e| ConsoleError::Other(e.to_string()))?;
        stream
            .set_write_timeout(Some(TIMEOUT))
            .map_err(|e| ConsoleError::Other(e.to_string()))?;
        let payload = body.map(json::dump);
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}:{}\r\nAccept-Encoding: identity\r\nUser-Agent: reverie-routines\r\nConnection: close\r\n",
            self.host, self.port
        );
        if let Some(p) = &payload {
            request.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                p.len()
            ));
        }
        if let Some(token) = token {
            request.push_str(&format!("X-Reverie-Service-Token: {token}\r\n"));
        }
        request.push_str("\r\n");
        if let Some(p) = &payload {
            request.push_str(p);
        }
        stream
            .write_all(request.as_bytes())
            .map_err(|e| ConsoleError::Other(e.to_string()))?;
        let (status, raw) = read_response(&mut stream)?;
        if !(200..300).contains(&status) {
            return Err(ConsoleError::Status(status));
        }
        if raw.len() > MAX_BODY {
            return other("console reply too large");
        }
        let value = if raw.is_empty() {
            Json::Obj(Vec::new())
        } else {
            let text = decode_json_bytes(&raw)?;
            json::parse(&text).map_err(|e| ConsoleError::Other(e.to_string()))?
        };
        if value.get("success") == Some(&Json::Bool(false)) {
            return other("console refused the call");
        }
        Ok(match value.get("data") {
            Some(data) => data.clone(),
            None => value,
        })
    }

    pub fn sessions(&self) -> Result<Json, ConsoleError> {
        self.request("GET", "/api/v1/sessions", None)
    }

    /// The number of console cron jobs, and nothing else: the count-only route, or the list while that route does not
    /// exist (404).
    pub fn cron_jobs(&self) -> Result<i128, ConsoleError> {
        match self.request("GET", "/api/cron/count", None) {
            Ok(value) => {
                return match value.get("count") {
                    Some(Json::Int(n)) if *n >= 0 => Ok(*n),
                    _ => other("unexpected cron count"),
                };
            }
            Err(ConsoleError::Status(404)) => {}
            Err(e) => return Err(e),
        }
        match self.request("GET", "/api/cron/jobs", None)? {
            Json::List(jobs) => Ok(i128::try_from(jobs.len()).unwrap_or(i128::MAX)),
            _ => other("unexpected cron list"),
        }
    }

    pub fn plan_usage(&self) -> Result<Json, ConsoleError> {
        self.request("GET", "/api/subscription-profiles/usage", None)
    }

    pub fn session(&self, session_id: &str) -> Result<Json, ConsoleError> {
        if !is_session_id(session_id) {
            return other("unexpected session id");
        }
        self.request("GET", &format!("/api/v1/sessions/{session_id}"), None)
    }

    /// Untagged input (F2): no clientId/seq, so the console never silently drops it as a duplicate. A reply that says
    /// the input was buffered, dropped or a duplicate is a failure; an empty or null success reply is accepted.
    pub fn send(&self, session_id: &str, text: &str) -> Result<(), ConsoleError> {
        if !is_session_id(session_id) {
            return other("unexpected session id");
        }
        let body = Json::Obj(vec![
            ("input".into(), Json::Str(format!("{text}\r"))),
            ("useMux".into(), Json::Bool(true)),
        ]);
        let reply = self.request(
            "POST",
            &format!("/api/v1/sessions/{session_id}/input"),
            Some(&body),
        )?;
        let reply = if reply == Json::Null {
            Json::Obj(Vec::new())
        } else {
            reply
        };
        let flagged = |k: &str| reply.get(k).is_some_and(Json::truthy);
        if !matches!(reply, Json::Obj(_))
            || flagged("buffered")
            || flagged("dropped")
            || flagged("duplicate")
        {
            return other("input not delivered");
        }
        Ok(())
    }
}
