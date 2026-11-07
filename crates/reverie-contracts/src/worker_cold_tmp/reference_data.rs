//! Purpose-specific proc metadata DATA. Reuse frozen Python digit/whitespace
//! facts; no current Rust Unicode tables, process exemptions or authority.
use super::*;
use crate::kernel_accounting;
use reverie_core::decimal::UnsignedInteger;

pub struct ReferenceProcessIdentity {
    state: String,
    start: String,
}
impl ReferenceProcessIdentity {
    pub fn parse(stat: &str) -> Result<Self> {
        let (_, tail) = stat.rsplit_once(')').ok_or(ColdDataError::Reference)?;
        let fields = kernel_accounting::words(tail);
        let start = *fields.get(19).ok_or(ColdDataError::Reference)?;
        if start.is_empty()
            || !start
                .chars()
                .all(|point| crate::rootless::is_digit(u32::from(point)))
        {
            return Err(ColdDataError::Reference);
        }
        Ok(Self {
            state: fields[0].to_owned(),
            start: start.to_owned(),
        })
    }
    pub fn start(&self) -> &str {
        &self.start
    }
    pub fn terminal(&self) -> bool {
        matches!(self.state.as_str(), "Z" | "X")
    }
}

/// The source uses bytes.splitlines/bytes.isdigit for Uid rows. Other bytes in
/// status need not be UTF8. Arbitrary precision IDs preserve valid nonmatches;
/// the existing Python int decimal limit remains at the conversion boundary.
pub fn reference_credentials(raw: &[u8], uid: u32) -> Result<bool> {
    let rows = byte_lines(raw)
        .into_iter()
        .filter(|line| line.starts_with(b"Uid:"))
        .collect::<Vec<_>>();
    if rows.len() != 1 {
        return Err(ColdDataError::Reference);
    }
    let fields = rows[0]
        .split(u8::is_ascii_whitespace)
        .filter(|field| !field.is_empty())
        .skip(1)
        .collect::<Vec<_>>();
    if fields.len() != 4 {
        return Err(ColdDataError::Reference);
    }
    let selected = UnsignedInteger::from_u64(u64::from(uid));
    let mut owned = false;
    for field in fields {
        owned |= integer(field)? == selected;
    }
    Ok(owned)
}
pub(super) fn integer(raw: &[u8]) -> Result<UnsignedInteger> {
    if raw.is_empty() || raw.len() > 4300 || !raw.iter().all(u8::is_ascii_digit) {
        return Err(ColdDataError::Reference);
    }
    UnsignedInteger::parse(std::str::from_utf8(raw).expect("ASCII digits"))
        .ok_or(ColdDataError::Reference)
}
fn strip(raw: &[u8]) -> &[u8] {
    let first = raw
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(raw.len());
    let last = raw
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(first, |last| last + 1);
    &raw[first..last]
}
#[derive(Default)]
pub struct ReferenceFdHeader {
    mount: Option<UnsignedInteger>,
    inode: Option<UnsignedInteger>,
}
impl ReferenceFdHeader {
    /// Feed at most16 actual readline(4097) results. Returning Some requires
    /// both identities, allowing the real reader to stop before event rows.
    pub fn push(&mut self, line: &[u8]) -> Result<Option<UnsignedInteger>> {
        if line.len() > 4096 {
            return Err(ColdDataError::Reference);
        }
        let Some(split) = line.iter().position(|&byte| byte == b':') else {
            return Ok(None);
        };
        let selected = match &line[..split] {
            b"mnt_id" => &mut self.mount,
            b"ino" => &mut self.inode,
            _ => return Ok(None),
        };
        if selected.is_some() {
            return Err(ColdDataError::Reference);
        }
        *selected = Some(integer(strip(&line[split + 1..]))?);
        Ok(self.inode.as_ref().and(self.mount.as_ref()).cloned())
    }
}
/// Python bytes.splitlines: only CR, LF and CRLF, unlike str.splitlines.
pub(crate) fn byte_lines(raw: &[u8]) -> Vec<&[u8]> {
    let mut rows = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < raw.len() {
        if matches!(raw[index], b'\r' | b'\n') {
            rows.push(&raw[start..index]);
            if raw[index] == b'\r' && raw.get(index + 1) == Some(&b'\n') {
                index += 1;
            }
            start = index + 1;
        }
        index += 1;
    }
    if start < raw.len() {
        rows.push(&raw[start..]);
    }
    rows
}
