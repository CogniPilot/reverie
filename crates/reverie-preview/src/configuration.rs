use http::{Uri, uri::PathAndQuery};
use serde::Deserialize;
use std::{
    fmt::Write,
    fs::File,
    io::{self, Read},
    net::IpAddr,
    path::{Path, PathBuf},
};

pub(crate) const INTERNAL_PATH: &str = "/__reverie_preview";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub(crate) version: u8,
    pub(crate) domain: String,
    office_origin: String,
    pub(crate) listen_address: IpAddr,
    pub(crate) port: u16,
    pub(crate) certificate: PathBuf,
    pub(crate) private_key: PathBuf,
    pub(crate) control_socket: PathBuf,
    pub(crate) deployment: String,
    pub(crate) audit_file: PathBuf,
}

impl Config {
    pub fn load(path: &Path) -> io::Result<Self> {
        let mut raw = Vec::new();
        File::open(path)?.take(65_537).read_to_end(&mut raw)?;
        if raw.len() > 65_536 {
            return Err(super::invalid("preview configuration too large"));
        }
        let config: Self = serde_json::from_slice(&raw)?;
        config.validate()?;
        Ok(config)
    }

    pub(crate) fn validate(&self) -> io::Result<()> {
        if self.version != 1 || !valid_domain(&self.domain) || self.domain.ends_with(".ts.net") {
            return Err(super::invalid(
                "a dedicated wildcard preview domain is required",
            ));
        }
        if !disjoint_https_origin(&self.office_origin, &self.domain) {
            return Err(super::invalid("a disjoint HTTPS office origin is required"));
        }
        if self.port < 1024 || !deployment(&self.deployment) {
            return Err(super::invalid(
                "invalid preview listener port or deployment",
            ));
        }
        if [
            &self.certificate,
            &self.private_key,
            &self.control_socket,
            &self.audit_file,
        ]
        .iter()
        .any(|path| !path.is_absolute())
        {
            return Err(super::invalid(
                "preview configuration paths must be absolute",
            ));
        }
        Ok(())
    }
}

fn valid_domain(value: &str) -> bool {
    let Some((prefix, suffix)) = value.rsplit_once('.') else {
        return false;
    };
    value.len() <= 200
        && (2..=63).contains(&suffix.len())
        && suffix.bytes().all(|byte| byte.is_ascii_lowercase())
        && prefix.split('.').all(domain_label)
}

fn domain_label(label: &str) -> bool {
    (1..=63).contains(&label.len())
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn disjoint_https_origin(origin: &str, domain: &str) -> bool {
    let Ok(uri) = origin.parse::<Uri>() else {
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    let host = authority.host().trim_end_matches('.').to_ascii_lowercase();
    uri.scheme_str() == Some("https")
        && !authority.as_str().contains('@')
        && !origin.contains('#')
        && uri.path() == "/"
        && uri.query().is_none()
        && host != domain
        && !host
            .strip_suffix(domain)
            .is_some_and(|parent| parent.ends_with('.'))
}

fn deployment(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn session_id(value: &str) -> bool {
    let lengths = [8, 4, 4, 4, 12];
    let parts = value.split('-');
    parts.clone().count() == lengths.len()
        && parts.zip(lengths).all(|(part, length)| hex(part, length))
}

pub(crate) fn port_allowed(port: u16) -> bool {
    port >= 1024 && !matches!(port, 8092 | 8093)
}

pub(crate) fn hostname(value: &str, domain: &str) -> bool {
    value
        .strip_suffix(domain)
        .and_then(|prefix| prefix.strip_suffix('.'))
        .is_some_and(|id| hex(id, 32))
}

pub(crate) fn page(value: &str) -> Option<PathAndQuery> {
    if !value.starts_with('/')
        || value.starts_with("//")
        || value.contains(['\\', '#'])
        || value.chars().count() > 4096
        || value.bytes().any(|byte| byte.is_ascii_control())
        || value.starts_with(INTERNAL_PATH)
    {
        return None;
    }
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_graphic() {
            encoded.push(char::from(byte));
        } else {
            write!(encoded, "%{byte:02X}").ok()?;
        }
    }
    encoded.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::{disjoint_https_origin, hostname, page, session_id, valid_domain};

    #[test]
    fn namespaces_and_registration_are_closed() {
        assert!(valid_domain("preview.example.test"));
        assert!(!valid_domain("bad-.example.test"));
        assert!(disjoint_https_origin(
            "https://office.example.test",
            "preview.example.test"
        ));
        for origin in [
            "https://preview.example.test.",
            "https://a.preview.example.test",
            "https://login@office.test",
            "http://office.test",
            "https://office.test/?q=1",
        ] {
            assert!(
                !disjoint_https_origin(origin, "preview.example.test"),
                "{origin}"
            );
        }
        assert!(hostname(
            "ab123456789012345678901234567890.preview.test",
            "preview.test"
        ));
        assert!(!hostname(
            "ab123456789012345678901234567890.preview.test.evil",
            "preview.test"
        ));
        assert!(session_id("11111111-2222-4333-8444-555555555555"));
        assert!(!session_id("11111111-2222-4333-8444-555555555555-"));
    }

    #[test]
    fn page_allows_local_escaped_paths() {
        assert_eq!(page("/a b/é?q=1").unwrap().as_str(), "/a%20b/%C3%A9?q=1");
        for value in [
            "https://host.test/",
            "//host.test/",
            "/\\host.test",
            "/__reverie_preview_open",
            "/x#part",
            "/\u{7f}",
        ] {
            assert!(page(value).is_none(), "{value}");
        }
    }
}
