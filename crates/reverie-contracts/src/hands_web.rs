//! Shared settings for the Hands launcher and its web tools.
use serde_json::{Map, Value};

pub const URL_CHARS: usize = 2048;

const INTEGER_LIMITS: &[(&str, u64, u64)] = &[
    ("search_max_calls", 1, 4),
    ("search_results", 1, 10),
    ("search_result_chars", 256, 8000),
    ("search_timeout_s", 1, 20),
    ("search_max_bytes", 4096, 2_000_000),
];

/// Reject control bytes shared by the two web URL settings.
pub fn url_text(url: &str) -> bool {
    (1..=URL_CHARS).contains(&url.chars().count())
        && !url
            .bytes()
            .any(|byte| byte <= 0x20 || matches!(byte, b'\\' | 0x7f))
}

/// Validate the web settings present in either a full configuration or overrides.
pub fn validate_settings(settings: &Map<String, Value>) -> Result<(), &'static str> {
    for key in ["search", "web_fetch"] {
        if settings.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err("Invalid Hands web boolean setting");
        }
    }
    let url = settings.get("search_url").filter(|item| !item.is_null());
    if url.is_some_and(|url| url.as_str().is_none_or(|url| !search_url(url))) {
        return Err("Invalid configured Hands search endpoint");
    }
    if settings.get("search") == Some(&Value::Bool(true)) && url.is_none() {
        return Err("Hands search requires an explicitly configured search_url");
    }
    if settings
        .get("web_log")
        .filter(|item| !item.is_null())
        .is_some_and(|item| {
            item.as_str().is_none_or(|path| {
                !path.starts_with('/') || path.split('/').any(|part| part == "..")
            })
        })
    {
        return Err("Private absolute Hands web_log required");
    }
    for &(key, low, high) in INTEGER_LIMITS {
        if settings
            .get(key)
            .is_some_and(|v| v.as_u64().is_none_or(|n| !(low..=high).contains(&n)))
        {
            return Err("Invalid bounded Hands web setting");
        }
    }
    Ok(())
}

fn search_url(url: &str) -> bool {
    if !url_text(url) {
        return false;
    }
    let url = url.strip_suffix('#').unwrap_or(url);
    let url = url.strip_suffix('?').unwrap_or(url);
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"))
        || rest.contains(['?', '#'])
    {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or_default();
    if authority.contains('@') {
        return false;
    }
    if let Some(ip) = authority.strip_prefix('[') {
        return ip.split_once(']').is_some_and(|(host, suffix)| {
            search_ipv6_host(host)
                && (suffix.is_empty() || suffix.strip_prefix(':').is_some_and(valid_port))
        });
    }
    let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
    !host.is_empty() && !host.contains(['[', ']']) && valid_port(port)
}

fn search_ipv6_host(host: &str) -> bool {
    let ip = match host.split_once('%') {
        Some((ip, zone)) if !zone.is_empty() && !zone.contains('%') => ip,
        Some(_) => return false,
        None => host,
    };
    ip.parse::<std::net::Ipv6Addr>().is_ok()
}

fn valid_port(port: &str) -> bool {
    port.is_empty()
        || (port.bytes().all(|byte| byte.is_ascii_digit()) && port.parse::<u16>().is_ok())
}
