use super::{Failure, Result};
use nix::{
    poll::{PollFd, PollFlags, PollTimeout, poll},
    unistd,
};
use std::{
    os::fd::AsFd,
    time::{Duration, Instant},
};
pub(super) const LIMIT: usize = 2048;
pub(super) fn read() -> Result<Vec<u8>> {
    let input = std::io::stdin();
    let end = Instant::now() + Duration::from_secs(3);
    let mut bytes = Vec::new();
    loop {
        let remaining = end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(Failure::refused("stdin-timeout"));
        }
        let timeout = PollTimeout::try_from(remaining)
            .map_err(|error| Failure::new("stdin-timeout", error))?;
        let mut descriptors = [PollFd::new(input.as_fd(), PollFlags::POLLIN)];
        let ready =
            poll(&mut descriptors, timeout).map_err(|error| Failure::new("stdin-poll", error))?;
        if ready == 0 {
            return Err(Failure::refused("stdin-timeout"));
        }
        let mut chunk = [0_u8; 512];
        let count =
            unistd::read(&input, &mut chunk).map_err(|error| Failure::new("stdin-read", error))?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > LIMIT + 1 {
            return Err(Failure::refused("stdin-bound"));
        }
    }
    validate(bytes)
}
fn validate(mut bytes: Vec<u8>) -> Result<Vec<u8>> {
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.len() > LIMIT {
        return Err(Failure::refused("token-shape"));
    }
    let text = std::str::from_utf8(&bytes).map_err(|error| Failure::new("token-shape", error))?;
    let Some((body, signature)) = text.split_once('.') else {
        return Err(Failure::refused("token-shape"));
    };
    if body.is_empty()
        || !body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        || !super::valid_digest(signature)
    {
        return Err(Failure::refused("token-shape"));
    }
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_encoding_and_exact_token_framing() {
        let token = format!("synthetic.{}", "a".repeat(64));
        assert_eq!(
            validate(format!("{token}\n").into_bytes()).unwrap(),
            token.as_bytes()
        );
        for bytes in [
            Vec::new(),
            vec![255],
            format!("{token}\n\n").into_bytes(),
            vec![b'a'; 2050],
            format!("{token}.extra").into_bytes(),
        ] {
            assert!(validate(bytes).is_err());
        }
    }
}
