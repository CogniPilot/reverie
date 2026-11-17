//! Read the fixed session-list endpoint using the packaged HTTP/TLS client.
use crate::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use http::{HeaderValue, Uri};
use serde_json::Value;
use std::{
    env,
    io::{Read, Write},
    process::{Child, Command, Stdio},
};

const SESSIONS: &str = "/api/v1/sessions";
const MAX_RESPONSE: usize = 16 * 1024 * 1024;
const MAX_REDIRECTS: usize = 10;
const CURL: &str = match option_env!("REVERIE_FIXED_BACKEND_CURL") {
    Some(path) => path,
    None => "curl",
};

fn http_uri(url: &str) -> Result<Uri> {
    let uri = url.parse::<Uri>().map_err(|_| "invalid Reverie API URL")?;
    if !matches!(uri.scheme_str(), Some("http" | "https"))
        || !uri.authority().is_some_and(|authority| {
            !authority.host().is_empty() && !authority.as_str().contains('@')
        })
        || url.contains('#')
    {
        return Err("configure a Reverie HTTP API URL without embedded credentials or fragment");
    }
    Ok(uri)
}

fn origin_matches(original: &Uri, next: &Uri) -> bool {
    fn port(uri: &Uri) -> u16 {
        uri.port_u16()
            .unwrap_or(if uri.scheme_str() == Some("https") {
                443
            } else {
                80
            })
    }
    original.scheme() == next.scheme()
        && port(original) == port(next)
        && original
            .host()
            .zip(next.host())
            .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right))
}

fn headers(id: &str) -> Result<String> {
    HeaderValue::from_str(id).map_err(|_| "invalid Reverie session identity")?;
    let mut headers = format!("Content-Type: application/json\nX-Reverie-Parent-Session: {id}\n");
    if let Ok(password) = env::var("REVERIE_PASSWORD")
        && !password.is_empty()
    {
        let username = env::var("REVERIE_USERNAME").unwrap_or_else(|_| "admin".into());
        let authorization = STANDARD.encode(format!("{username}:{password}"));
        headers.push_str(&format!("Authorization: Basic {authorization}\n"));
    }
    Ok(headers)
}

fn curl(url: &str) -> Result<Child> {
    Command::new(CURL)
        .args([
            "-q",
            "--silent",
            "--globoff",
            "--proto",
            "=http,https",
            "--max-time",
            "45",
            "--header",
            "@-",
            "--write-out",
            "\\n%{http_code}\\n%{redirect_url}",
            "--url",
            url,
        ])
        .env_remove("REVERIE_PASSWORD")
        .env_remove("SSLKEYLOGFILE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "could not start the Reverie API client")
}

fn exchange(child: &mut Child, headers: &str) -> Result<Vec<u8>> {
    child
        .stdin
        .take()
        .ok_or("Reverie API client has no input pipe")?
        .write_all(headers.as_bytes())
        .map_err(|_| "could not send the Reverie API request")?;
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .ok_or("Reverie API client has no output pipe")?
        .take(MAX_RESPONSE as u64 + 1)
        .read_to_end(&mut output)
        .map_err(|_| "could not read the Reverie API response")?;
    if output.len() > MAX_RESPONSE {
        return Err("Reverie API response is too large");
    }
    Ok(output)
}

enum Response {
    Sessions(Value),
    Redirect(String),
}

fn request(url: &str, headers: &str) -> Result<Response> {
    let mut child = curl(url)?;
    let response = exchange(&mut child, headers);
    if response.is_err() {
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|_| "Reverie API client did not finish")?;
    let response = response?;
    if !status.success() {
        return Err("Reverie API request failed");
    }
    let response = std::str::from_utf8(&response).map_err(|_| "invalid Reverie API response")?;
    let mut fields = response.rsplitn(3, '\n');
    match (fields.next(), fields.next(), fields.next()) {
        (Some(_), Some(status), Some(body)) if status.starts_with('2') => {
            let value = serde_json::from_str(body).map_err(|_| "invalid Reverie API response")?;
            Ok(Response::Sessions(value))
        }
        (Some(location), Some("301" | "302" | "303" | "307" | "308"), Some(_))
            if !location.is_empty() =>
        {
            Ok(Response::Redirect(location.to_owned()))
        }
        _ => Err("Reverie API rejected the session lookup"),
    }
}

pub(super) fn sessions(base: &str, id: &str) -> Result<Value> {
    let base = base.trim_end_matches('/');
    let origin = http_uri(base)?;
    if origin.query().is_some() {
        return Err("configure a Reverie API base URL without a query");
    }
    let mut url = format!("{base}{SESSIONS}");
    let headers = headers(id)?;
    for _ in 0..=MAX_REDIRECTS {
        match request(&url, &headers)? {
            Response::Sessions(value) => return Ok(value),
            Response::Redirect(next) => {
                if !origin_matches(&origin, &http_uri(&next)?) {
                    return Err("Reverie API redirected to a different origin");
                }
                url = next;
            }
        }
    }
    Err("Reverie API redirect limit reached")
}

pub(super) fn resolve_session<'a>(value: &'a Value, prefix: &str) -> Result<&'a Value> {
    if value["success"].as_bool() == Some(false) {
        return Err("Reverie API rejected the session lookup");
    }
    let data = value.get("data").unwrap_or(value);
    let sessions = data.get("sessions").unwrap_or(data);
    let mut matches = sessions
        .as_array()
        .ok_or("invalid Reverie session list")?
        .iter()
        .filter(|session| {
            session["id"]
                .as_str()
                .is_some_and(|id| id.starts_with(prefix))
        });
    let unique = matches.next().filter(|_| matches.next().is_none());
    unique.ok_or("cannot uniquely resolve the current Reverie session")
}
