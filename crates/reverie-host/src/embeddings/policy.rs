use super::{LlamaError, Result, idna::host_to_ascii, transport};
use base64::{Engine, engine::general_purpose::STANDARD};
use http::{HeaderValue, Uri, uri::PathAndQuery};
use std::{collections::BTreeMap, ffi::OsString};
#[derive(Clone, Default)]
pub(super) struct ProxySettings {
    values: BTreeMap<String, OsString>,
}
impl ProxySettings {
    pub(super) fn capture() -> Self {
        Self::from_pairs(std::env::vars_os().collect())
    }
    pub(super) fn from_pairs(pairs: Vec<(OsString, OsString)>) -> Self {
        let mut values = BTreeMap::new();
        for (key, value) in &pairs {
            if let Some(key) = key
                .to_str()
                .map(str::to_lowercase)
                .and_then(|key| key.strip_suffix("_proxy").map(str::to_owned))
                && !value.is_empty()
            {
                values.insert(key, value.clone());
            }
        }
        if pairs.iter().any(|(key, _)| key == "REQUEST_METHOD") {
            values.remove("http");
        }
        for (key, value) in pairs {
            let Some(key) = key.to_str().and_then(|key| key.strip_suffix("_proxy")) else {
                continue;
            };
            let key = key.to_lowercase();
            if value.is_empty() {
                values.remove(&key);
            } else {
                values.insert(key, value);
            }
        }
        Self { values }
    }
    pub(super) fn selected(&self, target: &Endpoint) -> Result<Option<Endpoint>> {
        let Some(proxy) = self.values.get(target.scheme()) else {
            return Ok(None);
        };
        let proxy = ParsedProxy::parse(proxy.to_str().ok_or(LlamaError::InvalidEndpoint)?)?;
        if let Some(bypass) = self.values.get("no")
            && bypass_host(
                &target.authority,
                bypass.to_str().ok_or(LlamaError::InvalidEndpoint)?,
            )
        {
            return Ok(None);
        }
        let secure = match proxy.scheme.as_deref() {
            None => target.secure,
            Some("http") => false,
            Some("https") => true,
            _ if target.secure => false,
            _ => return Err(LlamaError::UnsupportedTransport),
        };
        Endpoint::new(proxy.authority, secure, proxy.authorization).map(Some)
    }
}
fn bypass_host(host: &str, list: &str) -> bool {
    if list == "*" {
        return true;
    }
    let host = lowercase(host);
    let host_only = host
        .rsplit_once(':')
        .filter(|(_, port)| port.bytes().all(|byte| byte.is_ascii_digit()))
        .map_or(host.as_str(), |(host, _)| host);
    list.split(',').any(|part| {
        let part = lowercase(reverie_core::memory::trim_text(part).trim_start_matches('.'));
        !part.is_empty()
            && (host_only == part
                || host == part
                || host_only.ends_with(&format!(".{part}"))
                || host.ends_with(&format!(".{part}")))
    })
}
fn lowercase(value: &str) -> String {
    reverie_core::python_lowercase_string(value)
}
pub(super) struct Endpoint {
    pub authority: String,
    pub host: String,
    port: Option<String>,
    pub secure: bool,
    pub authorization: Option<String>,
}
impl Endpoint {
    fn new(authority: String, secure: bool, authorization: Option<String>) -> Result<Self> {
        if authority.is_empty() {
            return Err(LlamaError::InvalidEndpoint);
        }
        let (host, port) = host_port(&authority)?;
        if host.chars().any(|c| c <= ' ' || c == '\u{7f}') {
            return Err(LlamaError::InvalidEndpoint);
        }
        Ok(Self {
            authority,
            host,
            port,
            secure,
            authorization,
        })
    }
    pub(super) fn scheme(&self) -> &'static str {
        if self.secure { "https" } else { "http" }
    }
    pub(super) fn port(&self) -> Result<u16> {
        self.port
            .as_deref()
            .filter(|port| !port.is_empty())
            .map(integer_port)
            .unwrap_or(Ok(if self.secure { 443 } else { 80 }))
    }
    pub(super) fn ascii_host(&self) -> Result<String> {
        host_to_ascii(&self.host).map_err(|_| LlamaError::InvalidEndpoint)
    }
}
fn integer_port(value: &str) -> Result<u16> {
    let value = reverie_core::python_numeric_text(value).ok_or(LlamaError::InvalidEndpoint)?;
    let value = value.trim_matches([' ', '\t', '\r', '\n', '\u{b}', '\u{c}']);
    let negative = value.starts_with('-');
    let value = value.strip_prefix(['+', '-']).unwrap_or(value);
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return Err(LlamaError::InvalidEndpoint);
    }
    let mut number = 0_u16;
    let mut digits = 0;
    for (index, &byte) in bytes.iter().enumerate() {
        if byte == b'_' {
            if index == 0
                || index + 1 == bytes.len()
                || !bytes[index - 1].is_ascii_digit()
                || !bytes[index + 1].is_ascii_digit()
            {
                return Err(LlamaError::InvalidEndpoint);
            }
            continue;
        }
        if !byte.is_ascii_digit() {
            return Err(LlamaError::InvalidEndpoint);
        }
        digits += 1;
        number = number
            .checked_mul(10)
            .and_then(|value| value.checked_add(u16::from(byte - b'0')))
            .ok_or(LlamaError::InvalidEndpoint)?;
    }
    if digits > 4300 || negative && number != 0 {
        return Err(LlamaError::InvalidEndpoint);
    }
    Ok(number)
}
fn host_port(authority: &str) -> Result<(String, Option<String>)> {
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let end = rest.find(']').ok_or(LlamaError::InvalidEndpoint)?;
        let suffix = &rest[end + 1..];
        let port = if suffix.is_empty() {
            None
        } else {
            Some(
                suffix
                    .strip_prefix(':')
                    .ok_or(LlamaError::InvalidEndpoint)?
                    .to_owned(),
            )
        };
        (rest[..end].to_owned(), port)
    } else {
        authority
            .rsplit_once(':')
            .map_or((authority.to_owned(), None), |(host, port)| {
                (host.to_owned(), Some(port.to_owned()))
            })
    };
    if host.is_empty() {
        return Err(LlamaError::InvalidEndpoint);
    }
    Ok((host, port))
}
pub(super) struct Origin {
    pub network: Endpoint,
    pub full_url: String,
    pub path: PathAndQuery,
    pub forward: Option<Uri>,
    pub host_header: HeaderValue,
}
impl Origin {
    pub(super) fn parse_text(
        raw: &reverie_contracts::storage_identity::MetadataText,
    ) -> Result<Self> {
        if let Some(raw) = raw.scalar_text() {
            return Self::parse(&raw);
        }
        let raw = request_url_codepoints(raw)?;
        Self::parse_prepared(&raw)
    }
    pub(super) fn parse(raw: &str) -> Result<Self> {
        let raw = request_url(raw);
        Self::parse_prepared(raw)
    }
    fn parse_prepared(raw: &str) -> Result<Self> {
        let selected = raw.split('#').next().unwrap_or(raw);
        let (scheme, rest) = selected
            .split_once("://")
            .ok_or(LlamaError::InvalidEndpoint)?;
        let secure = if scheme.eq_ignore_ascii_case("http") {
            false
        } else if scheme.eq_ignore_ascii_case("https") {
            true
        } else {
            return Err(LlamaError::UnsupportedTransport);
        };
        let end = rest.find(['/', '?']).unwrap_or(rest.len());
        let authority = &rest[..end];
        if authority.contains('@') {
            return Err(LlamaError::InvalidEndpoint);
        }
        let network = Endpoint::new(authority.to_owned(), secure, None)?;
        let path = &rest[end..];
        let path = if path.starts_with('?') {
            format!("/{path}")
        } else if path.is_empty() {
            "/".to_owned()
        } else {
            path.to_owned()
        };
        if !path.is_ascii() || path.bytes().any(|byte| byte <= 32 || byte == 127) {
            return Err(LlamaError::InvalidEndpoint);
        }
        let header = authority
            .chars()
            .map(|c| u8::try_from(u32::from(c)).map_err(|_| LlamaError::InvalidEndpoint))
            .collect::<Result<Vec<_>>>()?;
        let host_header = HeaderValue::from_bytes(&header).map_err(transport)?;
        let forward = selected.is_ascii().then(|| selected.parse().ok()).flatten();
        Ok(Self {
            network,
            full_url: raw.to_owned(),
            path: path.parse().map_err(transport)?,
            forward,
            host_header,
        })
    }
}
fn request_url_codepoints(
    raw: &reverie_contracts::storage_identity::MetadataText,
) -> Result<String> {
    let mut points = raw.as_python_text_ref().trimmed().codepoints().into_owned();
    if points.first() == Some(&60) && points.last() == Some(&62) {
        points = trim_points(&points[1..points.len() - 1])?;
    }
    if points.starts_with(&[85, 82, 76, 58]) {
        points = trim_points(&points[4..])?;
    }
    // Request removes its fragment only after strip/unwrap and before network
    // encoding. A discarded surrogate is not a network-text encoding failure.
    points.truncate(
        points
            .iter()
            .position(|&cp| cp == 35)
            .unwrap_or(points.len()),
    );
    points
        .into_iter()
        .map(char::from_u32)
        .collect::<Option<String>>()
        .ok_or(LlamaError::InvalidEndpoint)
}
fn trim_points(points: &[u32]) -> Result<Vec<u32>> {
    Ok(reverie_core::PythonTextRef::from_codepoints(points)
        .map_err(|_| LlamaError::InvalidEndpoint)?
        .trimmed()
        .codepoints()
        .into_owned())
}
fn request_url(raw: &str) -> &str {
    let raw = reverie_core::memory::trim_text(raw);
    let raw = if raw.starts_with('<') && raw.ends_with('>') {
        reverie_core::memory::trim_text(&raw[1..raw.len() - 1])
    } else {
        raw
    };
    raw.strip_prefix("URL:")
        .map_or(raw, reverie_core::memory::trim_text)
}
struct ParsedProxy {
    scheme: Option<String>,
    authority: String,
    authorization: Option<String>,
}
impl ParsedProxy {
    fn parse(raw: &str) -> Result<Self> {
        let split = raw.find(':').filter(|&index| !raw[..index].contains('/'));
        let (scheme, authority) = if let Some(index) = split {
            let remainder = &raw[index + 1..];
            if !remainder.starts_with('/') {
                (None, raw)
            } else {
                let remainder = remainder
                    .strip_prefix("//")
                    .ok_or(LlamaError::InvalidEndpoint)?;
                let offset = remainder.find('@').unwrap_or(0);
                let end = remainder[offset..]
                    .find('/')
                    .map_or(remainder.len(), |index| index + offset);
                (Some(lowercase(&raw[..index])), &remainder[..end])
            }
        } else {
            (None, raw)
        };
        let (authorization, host) = if let Some((credentials, host)) = authority.rsplit_once('@') {
            let header = credentials
                .split_once(':')
                .filter(|(user, password)| !user.is_empty() && !password.is_empty())
                .map(|(user, password)| {
                    format!(
                        "Basic {}",
                        STANDARD.encode(format!(
                            "{}:{}",
                            String::from_utf8_lossy(&percent_decode(user)),
                            String::from_utf8_lossy(&percent_decode(password))
                        ))
                    )
                });
            (header, host)
        } else {
            (None, authority)
        };
        Ok(Self {
            scheme,
            authority: String::from_utf8_lossy(&percent_decode(host)).into_owned(),
            authorization,
        })
    }
}
fn percent_decode(value: &str) -> Vec<u8> {
    let input = value.as_bytes();
    let mut bytes = Vec::new();
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%'
            && let Some(encoded) = input.get(index + 1..index + 3)
            && let (Some(high), Some(low)) = (
                (encoded[0] as char).to_digit(16),
                (encoded[1] as char).to_digit(16),
            )
        {
            bytes.push((high * 16 + low) as u8);
            index += 3;
        } else {
            bytes.push(input[index]);
            index += 1;
        }
    }
    bytes
}
