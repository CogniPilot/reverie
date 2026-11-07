//! Named proc maps/unix DATA parsers. Byte framing stays distinct from Python
//! str framing; filesystem paths reuse Core's lossless surrogateescape owner.
use super::reference_data::{byte_lines, integer};
use super::*;
use reverie_core::{PythonText, decimal::UnsignedInteger, posix_text};

pub struct ReferenceUnixRow {
    inode: UnsignedInteger,
    path: Option<MetadataText>,
}
impl ReferenceUnixRow {
    pub fn parse(raw: &[u8]) -> Result<Vec<Self>> {
        byte_lines(raw)
            .into_iter()
            .skip(1)
            .map(|line| {
                let fields = fields(line, 7);
                if fields.len() < 7 {
                    return Err(ColdDataError::Reference);
                }
                Ok(Self {
                    inode: integer(fields[6])?,
                    path: fields.get(7).map(|bytes| text(bytes)),
                })
            })
            .collect()
    }
    pub fn inode(&self) -> &UnsignedInteger {
        &self.inode
    }
    pub fn path(&self) -> Option<&MetadataText> {
        self.path.as_ref()
    }
}
pub struct ReferenceMapRow {
    device: (u32, u32),
    negative: bool,
    inode: UnsignedInteger,
    path: Option<MetadataText>,
}
impl ReferenceMapRow {
    pub fn parse(raw: &[u8]) -> Result<Vec<Self>> {
        byte_lines(raw)
            .into_iter()
            .map(|line| {
                let fields = fields(line, 5);
                if fields.len() < 5 {
                    return Err(ColdDataError::Reference);
                }
                let split = fields[3].split(|&byte| byte == b':').collect::<Vec<_>>();
                if split.len() != 2 {
                    return Err(ColdDataError::Reference);
                }
                let device = (hex(split[0])?, hex(split[1])?);
                if !fields[4].is_ascii() {
                    return Err(ColdDataError::Reference);
                }
                let (negative, inode) = crate::rootless::parse_python_integer(
                    &fields[4]
                        .iter()
                        .map(|&byte| u32::from(byte))
                        .collect::<Vec<_>>(),
                )
                .ok_or(ColdDataError::Reference)?;
                Ok(Self {
                    device,
                    negative,
                    inode,
                    path: fields.get(5).map(|bytes| text(bytes)),
                })
            })
            .collect()
    }
    pub fn device(&self) -> (u32, u32) {
        self.device
    }
    pub fn zero_inode(&self) -> bool {
        self.inode.is_zero()
    }
    pub fn inode(&self) -> Option<&UnsignedInteger> {
        (!self.negative).then_some(&self.inode)
    }
    pub fn path(&self) -> Option<&MetadataText> {
        self.path.as_ref()
    }
}
fn text(bytes: &[u8]) -> MetadataText {
    MetadataText::from_python_text(
        PythonText::try_new(posix_text::decode(bytes)).expect("decoded codepoints"),
    )
}
// Python bytes.split(None,maxsplit), retaining the final field's spaces.
fn fields(mut bytes: &[u8], splits: usize) -> Vec<&[u8]> {
    let mut result = Vec::new();
    loop {
        let first = bytes
            .iter()
            .position(|byte| !byte.is_ascii_whitespace())
            .unwrap_or(bytes.len());
        bytes = &bytes[first..];
        if bytes.is_empty() {
            return result;
        }
        if result.len() == splits {
            result.push(bytes);
            return result;
        }
        let width = bytes
            .iter()
            .position(u8::is_ascii_whitespace)
            .unwrap_or(bytes.len());
        result.push(&bytes[..width]);
        bytes = &bytes[width..];
    }
}
fn hex(mut raw: &[u8]) -> Result<u32> {
    let negative = raw.first() == Some(&b'-');
    if matches!(raw.first(), Some(b'+' | b'-')) {
        raw = &raw[1..];
    }
    if raw
        .get(..2)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"0x"))
    {
        raw = &raw[2..];
        if raw.first() == Some(&b'_') {
            raw = &raw[1..];
        }
    }
    let mut value = 0_u32;
    let mut digit = false;
    for &byte in raw {
        if byte == b'_' {
            if !digit {
                return Err(ColdDataError::Reference);
            }
            digit = false;
            continue;
        }
        let next = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return Err(ColdDataError::Reference),
        };
        value = value
            .checked_mul(16)
            .and_then(|value| value.checked_add(u32::from(next)))
            .ok_or(ColdDataError::Reference)?;
        digit = true;
    }
    if !digit || (negative && value != 0) {
        return Err(ColdDataError::Reference);
    }
    Ok(value)
}
