use super::Error;

/// Decode one UTF-8 codepoint with Python's surrogatepass extension. Overlong,
/// truncated and out-of-range sequences still refuse. No replacement characters.
pub(super) fn codepoint(raw: &[u8]) -> Result<(u32, usize), Error> {
    let first = *raw.first().ok_or(Error::InvalidJson)?;
    let (width, mut value, minimum) = match first {
        0..=0x7f => return Ok((u32::from(first), 1)),
        0xc2..=0xdf => (2, u32::from(first & 0x1f), 0x80),
        0xe0..=0xef => (3, u32::from(first & 0x0f), 0x800),
        0xf0..=0xf4 => (4, u32::from(first & 7), 0x10000),
        _ => return Err(Error::InvalidJson),
    };
    for &byte in raw.get(1..width).ok_or(Error::InvalidJson)? {
        if byte & 0xc0 != 0x80 {
            return Err(Error::InvalidJson);
        }
        value = (value << 6) | u32::from(byte & 0x3f);
    }
    if value < minimum || value > 0x10ffff {
        return Err(Error::InvalidJson);
    }
    Ok((value, width))
}
fn append(codepoint: u32, result: &mut Vec<u8>) -> Result<(), Error> {
    if codepoint > 0x10ffff {
        return Err(Error::InvalidJson);
    }
    if codepoint < 0x80 {
        result.push(codepoint as u8);
    } else if codepoint < 0x800 {
        result.extend([0xc0 | (codepoint >> 6) as u8, 0x80 | (codepoint & 63) as u8]);
    } else if codepoint < 0x10000 {
        result.extend([
            0xe0 | (codepoint >> 12) as u8,
            0x80 | ((codepoint >> 6) & 63) as u8,
            0x80 | (codepoint & 63) as u8,
        ]);
    } else {
        result.extend([
            0xf0 | (codepoint >> 18) as u8,
            0x80 | ((codepoint >> 12) & 63) as u8,
            0x80 | ((codepoint >> 6) & 63) as u8,
            0x80 | (codepoint & 63) as u8,
        ]);
    }
    Ok(())
}
enum Encoding {
    Utf8(usize),
    Utf16(bool, usize),
    Utf32(bool, usize),
}
fn encoding(raw: &[u8]) -> Encoding {
    if raw.starts_with(&[0, 0, 0xfe, 0xff]) {
        return Encoding::Utf32(false, 4);
    }
    if raw.starts_with(&[0xff, 0xfe, 0, 0]) {
        return Encoding::Utf32(true, 4);
    }
    if raw.starts_with(&[0xfe, 0xff]) {
        return Encoding::Utf16(false, 2);
    }
    if raw.starts_with(&[0xff, 0xfe]) {
        return Encoding::Utf16(true, 2);
    }
    if raw.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Encoding::Utf8(3);
    }
    if raw.len() >= 4 {
        if raw[0] == 0 {
            return if raw[1] != 0 {
                Encoding::Utf16(false, 0)
            } else {
                Encoding::Utf32(false, 0)
            };
        }
        if raw[1] == 0 {
            return if raw[2] != 0 || raw[3] != 0 {
                Encoding::Utf16(true, 0)
            } else {
                Encoding::Utf32(true, 0)
            };
        }
    } else if raw.len() == 2 {
        if raw[0] == 0 {
            return Encoding::Utf16(false, 0);
        }
        if raw[1] == 0 {
            return Encoding::Utf16(true, 0);
        }
    }
    Encoding::Utf8(0)
}
pub(super) fn python_bytes(raw: &[u8]) -> Result<Vec<u8>, Error> {
    match encoding(raw) {
        Encoding::Utf8(offset) => Ok(raw[offset..].to_vec()),
        Encoding::Utf16(little, offset) => utf16(&raw[offset..], little),
        Encoding::Utf32(little, offset) => utf32(&raw[offset..], little),
    }
}
fn utf16(raw: &[u8], little: bool) -> Result<Vec<u8>, Error> {
    if !raw.len().is_multiple_of(2) {
        return Err(Error::InvalidJson);
    }
    let units: Vec<_> = raw
        .chunks_exact(2)
        .map(|pair| {
            let bytes = [pair[0], pair[1]];
            if little {
                u16::from_le_bytes(bytes)
            } else {
                u16::from_be_bytes(bytes)
            }
        })
        .collect();
    let mut result = Vec::new();
    let mut offset = 0;
    while offset < units.len() {
        let mut value = u32::from(units[offset]);
        offset += 1;
        if (0xd800..=0xdbff).contains(&value)
            && units
                .get(offset)
                .is_some_and(|low| (0xdc00..=0xdfff).contains(low))
        {
            value = 0x10000 + ((value - 0xd800) << 10) + u32::from(units[offset]) - 0xdc00;
            offset += 1;
        }
        append(value, &mut result)?;
    }
    Ok(result)
}
fn utf32(raw: &[u8], little: bool) -> Result<Vec<u8>, Error> {
    if !raw.len().is_multiple_of(4) {
        return Err(Error::InvalidJson);
    }
    let mut result = Vec::new();
    for unit in raw.chunks_exact(4) {
        let bytes = [unit[0], unit[1], unit[2], unit[3]];
        append(
            if little {
                u32::from_le_bytes(bytes)
            } else {
                u32::from_be_bytes(bytes)
            },
            &mut result,
        )?;
    }
    Ok(result)
}
