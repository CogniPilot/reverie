//! Python POSIX filesystem surrogateescape conversion only. These portable
//! byte/codepoint transforms perform no normalization, lookup or authority check.
use std::fmt;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PosixEncodingError;
impl fmt::Display for PosixEncodingError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("POSIX_FILESYSTEM_ENCODING")
    }
}
impl std::error::Error for PosixEncodingError {}
pub fn encode(points: &[u32]) -> Result<Vec<u8>, PosixEncodingError> {
    let mut bytes = Vec::new();
    for &point in points {
        if (0xdc80..=0xdcff).contains(&point) {
            bytes.push((point - 0xdc00) as u8);
            continue;
        }
        let character = char::from_u32(point).ok_or(PosixEncodingError)?;
        let mut encoded = [0; 4];
        bytes.extend_from_slice(character.encode_utf8(&mut encoded).as_bytes());
    }
    Ok(bytes)
}
pub fn decode(mut bytes: &[u8]) -> Vec<u32> {
    let mut points = Vec::new();
    while !bytes.is_empty() {
        match std::str::from_utf8(bytes) {
            Ok(value) => {
                points.extend(value.chars().map(u32::from));
                break;
            }
            Err(error) => {
                let prefix = std::str::from_utf8(&bytes[..error.valid_up_to()])
                    .expect("UTF-8 error identifies a valid prefix");
                points.extend(prefix.chars().map(u32::from));
                bytes = &bytes[error.valid_up_to()..];
                let invalid = error.error_len().unwrap_or(bytes.len());
                points.extend(
                    bytes[..invalid]
                        .iter()
                        .map(|&byte| 0xdc00 + u32::from(byte)),
                );
                bytes = &bytes[invalid..];
            }
        }
    }
    points
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_byte_roundtrip_and_invalid_codepoints_keep_surrogateescape_contract() {
        let bytes = (0..=255).collect::<Vec<u8>>();
        assert_eq!(encode(&decode(&bytes)).unwrap(), bytes);
        for point in [0xd800, 0xdbff, 0xdc00, 0xdc7f, 0x110000] {
            assert!(encode(&[point]).is_err());
        }
        assert_eq!(encode(&[0]).unwrap(), [0]);
        // Already-valid byte sequences decode to scalar text; input codepoints
        // retain their original spelling until a caller explicitly decodes.
        assert_eq!(encode(&[0xdcc2, 0xdc80]).unwrap(), [0xc2, 0x80]);
        assert_eq!(decode(&[0xc2, 0x80]), [0x80]);
    }
}
