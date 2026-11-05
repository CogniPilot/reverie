//! Python json.loads(bytes) encoding detection, limited to the legacy profile
//! decoder. Successful writes still emit the single canonical ASCII format.
use super::CodecError;

enum Encoding {
    Utf8,
    Utf16(bool),
    Utf32(bool),
}

fn encoding(raw: &[u8]) -> (Encoding, usize) {
    if raw.starts_with(&[0, 0, 0xfe, 0xff]) {
        return (Encoding::Utf32(false), 4);
    }
    if raw.starts_with(&[0xff, 0xfe, 0, 0]) {
        return (Encoding::Utf32(true), 4);
    }
    if raw.starts_with(&[0xfe, 0xff]) {
        return (Encoding::Utf16(false), 2);
    }
    if raw.starts_with(&[0xff, 0xfe]) {
        return (Encoding::Utf16(true), 2);
    }
    if raw.starts_with(&[0xef, 0xbb, 0xbf]) {
        return (Encoding::Utf8, 3);
    }
    if raw.len() >= 4 {
        if raw[..3] == [0, 0, 0] {
            return (Encoding::Utf32(false), 0);
        }
        if raw[1..4] == [0, 0, 0] {
            return (Encoding::Utf32(true), 0);
        }
        if raw[0] == 0 && raw[2] == 0 {
            return (Encoding::Utf16(false), 0);
        }
        if raw[1] == 0 && raw[3] == 0 {
            return (Encoding::Utf16(true), 0);
        }
    }
    (Encoding::Utf8, 0)
}

pub(super) fn decode(raw: &[u8]) -> Result<String, CodecError> {
    let (kind, offset) = encoding(raw);
    let bytes = &raw[offset..];
    match kind {
        Encoding::Utf8 => String::from_utf8(bytes.to_vec()).map_err(|_| CodecError::ClosedSchema),
        Encoding::Utf16(little) => utf16(bytes, little),
        Encoding::Utf32(little) => utf32(bytes, little),
    }
}
fn utf16(bytes: &[u8], little: bool) -> Result<String, CodecError> {
    if !bytes.len().is_multiple_of(2) {
        return Err(CodecError::ClosedSchema);
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16(&units).map_err(|_| CodecError::ClosedSchema)
}
fn utf32(bytes: &[u8], little: bool) -> Result<String, CodecError> {
    if !bytes.len().is_multiple_of(4) {
        return Err(CodecError::ClosedSchema);
    }
    bytes
        .chunks_exact(4)
        .map(|unit| {
            let array = [unit[0], unit[1], unit[2], unit[3]];
            let codepoint = if little {
                u32::from_le_bytes(array)
            } else {
                u32::from_be_bytes(array)
            };
            char::from_u32(codepoint).ok_or(CodecError::ClosedSchema)
        })
        .collect()
}
