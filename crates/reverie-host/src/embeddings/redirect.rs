//! urllib's purpose-specific redirect reference resolution. HTTP framing and
//! TLS remain owned by hyper/rustls; this preserves literal URI path segments.
use super::{LlamaError, Result};
#[derive(Default)]
struct Parts<'a> {
    scheme: &'a str,
    authority: &'a str,
    path: &'a str,
    params: &'a str,
    query: &'a str,
    fragment: &'a str,
}
fn parts<'a>(raw: &'a str, default_scheme: &'a str) -> Parts<'a> {
    let (raw, fragment) = raw.split_once('#').unwrap_or((raw, ""));
    let (raw, query) = raw.split_once('?').unwrap_or((raw, ""));
    let (scheme, raw) = raw
        .split_once(':')
        .filter(|(scheme, _)| valid_scheme(scheme))
        .unwrap_or((default_scheme, raw));
    let (authority, path) = if let Some(rest) = raw.strip_prefix("//") {
        let end = rest.find('/').unwrap_or(rest.len());
        (&rest[..end], &rest[end..])
    } else {
        ("", raw)
    };
    let last_slash = path.rfind('/').map_or(0, |index| index + 1);
    let (path, params) = path[last_slash..].find(';').map_or((path, ""), |offset| {
        (
            &path[..last_slash + offset],
            &path[last_slash + offset + 1..],
        )
    });
    Parts {
        scheme,
        authority,
        path,
        params,
        query,
        fragment,
    }
}
fn valid_scheme(value: &str) -> bool {
    value
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}
fn write(parts: &Parts<'_>, path: &str) -> String {
    let mut result = format!(
        "{}://{}",
        parts.scheme.to_ascii_lowercase(),
        parts.authority
    );
    if !path.is_empty() && !path.starts_with('/') {
        result.push('/');
    }
    result.push_str(path);
    for (marker, value) in [
        (';', parts.params),
        ('?', parts.query),
        ('#', parts.fragment),
    ] {
        if !value.is_empty() {
            result.push(marker);
            result.push_str(value);
        }
    }
    result
}
fn resolved_path(base: &str, selected: &str) -> String {
    let mut segments: Vec<_> = if selected.starts_with('/') {
        selected.split('/').collect()
    } else {
        let mut base: Vec<_> = base.split('/').collect();
        if base.last() != Some(&"") {
            base.pop();
        }
        base.extend(selected.split('/'));
        let last = base.len().saturating_sub(1);
        base.into_iter()
            .enumerate()
            .filter_map(|(index, value)| {
                (index == 0 || index == last || !value.is_empty()).then_some(value)
            })
            .collect()
    };
    let trailing = segments
        .last()
        .is_some_and(|last| matches!(*last, "." | ".."));
    let mut resolved = Vec::new();
    for segment in segments.drain(..) {
        match segment {
            ".." => {
                resolved.pop();
            }
            "." => {}
            value => resolved.push(value),
        }
    }
    if trailing {
        resolved.push("");
    }
    let path = resolved.join("/");
    if path.is_empty() { "/".into() } else { path }
}
pub(super) fn redirect_url(base: &str, location: &[u8]) -> Result<String> {
    let location = location
        .iter()
        .copied()
        .skip_while(|byte| *byte <= 32)
        .filter(|byte| !matches!(byte, b'\r' | b'\n' | b'\t'));
    let quoted = location
        .map(|byte| {
            if (33..=126).contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect::<String>();
    let base = parts(base, "");
    let mut target = parts(&quoted, base.scheme);
    if !["http", "https"]
        .iter()
        .any(|scheme| target.scheme.eq_ignore_ascii_case(scheme))
    {
        return Err(LlamaError::UnsupportedTransport);
    }
    if !target.authority.is_empty() {
        return Ok(write(
            &target,
            if target.path.is_empty() {
                "/"
            } else {
                target.path
            },
        ));
    }
    if !target.scheme.eq_ignore_ascii_case(base.scheme) {
        return Err(LlamaError::InvalidEndpoint);
    }
    target.authority = base.authority;
    if target.path.is_empty() && target.params.is_empty() {
        target.path = base.path;
        target.params = base.params;
        if target.query.is_empty() {
            target.query = base.query;
        }
        return Ok(write(&target, target.path));
    }
    let path = resolved_path(base.path, target.path);
    Ok(write(&target, &path))
}
