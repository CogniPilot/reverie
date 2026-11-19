//! Address of a local Office HTTP relay. This value carries no session authority.
use std::num::NonZeroU16;

/// Accept the fixed IPv4 loopback origin with an explicit, nonzero port.
pub fn loopback_port(origin: &str) -> Option<NonZeroU16> {
    let (scheme, address) = origin.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") {
        return None;
    }
    let address = address.strip_prefix("127.0.0.1:")?;
    let port = address.strip_suffix('/').unwrap_or(address);
    if !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse().ok()
}
