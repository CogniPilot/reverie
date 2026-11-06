//! The existing ops_cli.call urlsplit checks, not an arbitrary HTTP client.
use crate::{Result, Unavailable};
use reverie_core::{PythonText, memory_configuration::ConfigInteger};
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct OfficePhone {
    host: String,
    port: u16,
}
impl OfficePhone {
    pub(crate) fn parse(raw: &str) -> Result<Self> {
        // Python urlsplit removes leading C0/space and embedded TAB/CR/LF.
        let raw = raw
            .trim_start_matches(|c| c <= '\u{20}')
            .replace(['\t', '\r', '\n'], "");
        let raw = raw.split('#').next().ok_or(Unavailable)?;
        let (scheme, rest) = raw.split_once(':').ok_or(Unavailable)?;
        if !scheme.eq_ignore_ascii_case("http") {
            return Err(Unavailable);
        }
        let rest = rest.strip_prefix("//").ok_or(Unavailable)?;
        let end = rest.find(['/', '?']).unwrap_or(rest.len());
        let (authority, suffix) = rest.split_at(end);
        let (path, query) = suffix.split_once('?').unwrap_or((suffix, ""));
        if !matches!(path, "" | "/") || !query.is_empty() {
            return Err(Unavailable);
        }
        let authority = if let Some((userinfo, host)) = authority.rsplit_once('@') {
            // The source tests truthiness: an empty username/password is
            // accepted, but actual credentials are never selected/forwarded.
            if !matches!(userinfo, "" | ":") {
                return Err(Unavailable);
            }
            host
        } else {
            authority
        };
        let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
        let host = host.to_ascii_lowercase();
        if !matches!(host.as_str(), "127.0.0.1" | "localhost") {
            return Err(Unavailable);
        }
        let port = if port.is_empty() {
            80
        } else {
            if !port.bytes().all(|b| b.is_ascii_digit()) {
                return Err(Unavailable);
            }
            // Reuse the checked Python decimal conversion owner: leading
            // zeroes still count toward its frozen integer digit bound.
            let number =
                ConfigInteger::parse(&PythonText::from_scalar_text(port)).ok_or(Unavailable)?;
            let port = number.as_str().parse::<u16>().map_err(|_| Unavailable)?;
            if port == 0 { 80 } else { port }
        };
        Ok(Self { host, port })
    }
    pub(crate) fn host(&self) -> &str {
        &self.host
    }
    pub(crate) fn port(&self) -> u16 {
        self.port
    }
    pub(crate) fn host_header(&self) -> String {
        if self.port == 80 {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_python_port_digit_limit_counts_leading_zeroes() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/phone-port-python.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let count = usize::try_from(case["zeroCount"].as_u64().unwrap()).unwrap();
            let result = OfficePhone::parse(&format!("http://localhost:{}1", "0".repeat(count)));
            assert_eq!(
                result.is_ok(),
                case["accepted"].as_bool().unwrap(),
                "{case}"
            );
            if let Ok(phone) = result {
                assert_eq!(u64::from(phone.port()), case["port"].as_u64().unwrap());
            }
        }
    }
    #[test]
    fn actual_original_urlsplit_and_office_phone_checks_match() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/phone-address-python.json"))
                .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let raw = case["urlCodepoints"]
                .as_array()
                .unwrap()
                .iter()
                .map(|point| {
                    char::from_u32(u32::try_from(point.as_u64().unwrap()).unwrap())
                        .unwrap_or('\u{fffd}')
                })
                .collect::<String>();
            let result = OfficePhone::parse(&raw);
            assert_eq!(
                result.is_ok(),
                case["accepted"].as_bool().unwrap(),
                "{case}"
            );
            if let Ok(phone) = result {
                assert_eq!(phone.host(), case["host"].as_str().unwrap());
                assert_eq!(u64::from(phone.port()), case["port"].as_u64().unwrap());
            }
        }
    }
}
