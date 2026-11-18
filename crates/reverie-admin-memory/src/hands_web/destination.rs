use http::uri::PathAndQuery;
use reverie_contracts::hands_web::url_text;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};

const DNS_LIMIT: usize = 32;
const HTTPS: u16 = 443;

pub(super) struct Target {
    pub(super) host: String,
    pub(super) authority: String,
    pub(super) path: PathAndQuery,
}

impl Target {
    pub(super) fn parse(raw: &str) -> Option<Self> {
        if !url_text(raw) {
            return None;
        }
        let raw = raw.strip_suffix('#').unwrap_or(raw);
        let (scheme, rest) = raw.split_once("://")?;
        if !scheme.eq_ignore_ascii_case("https") || rest.contains('#') {
            return None;
        }
        let boundary = rest.find(['/', '?']).unwrap_or(rest.len());
        let (authority, path) = rest.split_at(boundary);
        let (host, authority) = host_parts(authority)?;
        let path = if path.starts_with('/') {
            path.into()
        } else {
            format!("/{path}")
        };
        Some(Self {
            host,
            authority,
            path: path.parse().ok()?,
        })
    }

    pub(super) async fn resolve(&self) -> Option<SocketAddr> {
        checked_address(
            tokio::net::lookup_host((self.host.as_str(), HTTPS))
                .await
                .ok()?,
        )
    }
}

fn host_parts(authority: &str) -> Option<(String, String)> {
    if authority.contains('@') {
        return None;
    }
    if let Some(ip) = authority.strip_prefix('[') {
        let (host, suffix) = ip.split_once(']')?;
        if !suffix.is_empty() && !https_port(suffix.strip_prefix(':')?) {
            return None;
        }
        let host = host.parse::<Ipv6Addr>().ok()?.to_string();
        return Some((host.clone(), format!("[{host}]")));
    }
    let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
    if !https_port(port) {
        return None;
    }
    let host = idna::domain_to_ascii(host).ok()?.to_ascii_lowercase();
    if !(1..=253).contains(&host.len())
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
    {
        return None;
    }
    Some((host.clone(), host))
}

fn https_port(raw: &str) -> bool {
    raw.is_empty() || (raw.bytes().all(|b| b.is_ascii_digit()) && raw.parse::<u16>() == Ok(HTTPS))
}

fn checked_address(addresses: impl IntoIterator<Item = SocketAddr>) -> Option<SocketAddr> {
    let mut addresses = addresses.into_iter();
    let first = addresses.next().filter(public)?;
    for (index, address) in addresses.enumerate() {
        if index >= DNS_LIMIT - 1 || !public(&address) {
            return None;
        }
    }
    Some(first)
}

fn public(address: &SocketAddr) -> bool {
    match address.ip() {
        IpAddr::V4(ip) => public_v4(ip.octets()),
        IpAddr::V6(ip) => {
            matches!(address, SocketAddr::V6(address) if address.scope_id() == 0)
                && public_v6(ip.segments())
        }
    }
}

fn public_v4(octets: [u8; 4]) -> bool {
    match octets {
        [192, 0, 0, 9 | 10] => true,
        [0 | 10 | 127 | 224..=255, ..]
        | [100, 64..=127, ..]
        | [169, 254, ..]
        | [172, 16..=31, ..]
        | [192, 0, 0 | 2, _]
        | [192, 168, ..]
        | [198, 18 | 19, ..]
        | [198, 51, 100, _]
        | [203, 0, 113, _] => false,
        _ => true,
    }
}

fn public_v6(segments: [u16; 8]) -> bool {
    match segments {
        // Globally reachable assignments inside IETF protocol space.
        [0x2001, 1, 0, 0, 0, 0, 0, 1 | 2]
        | [0x2001, 3, ..]
        | [0x2001, 4, 0x112, ..]
        | [0x2001, 0x20..=0x3f, ..] => true,
        [0x2001, 0..=0x1ff | 0xdb8, ..] | [0x2002, ..] | [0x3fff, 0..=0xfff, ..] => false,
        // Global unicast excludes mapped, scoped, multicast and translation prefixes.
        [0x2000..=0x3fff, ..] => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests;
