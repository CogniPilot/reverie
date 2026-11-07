//! getfattr's dump is line based. Each decoded name/value is independently
//! queried before use, so an unusual raw name cannot forge another dump row.
use super::{Result, SnapshotError, require};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    os::unix::ffi::{OsStrExt, OsStringExt},
};

pub(super) fn decode(raw: &[u8]) -> Result<Vec<(OsString, Vec<u8>)>> {
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let mut lines = raw.split(|byte| *byte == b'\n');
    require(
        lines
            .next()
            .is_some_and(|line| line.starts_with(b"# file: ")),
        "SNAPSHOT_ATTRIBUTE_FORMAT",
    )?;
    let mut names = BTreeSet::new();
    let mut result = Vec::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let split = line
            .iter()
            .position(|byte| *byte == b'=')
            .ok_or_else(|| SnapshotError::refused("SNAPSHOT_ATTRIBUTE_FORMAT"))?;
        let name = line[..split].to_vec();
        require(
            !name.is_empty() && names.insert(name.clone()),
            "SNAPSHOT_ATTRIBUTE_FORMAT",
        )?;
        let value = line[split + 1..]
            .strip_prefix(b"0x")
            .ok_or_else(|| SnapshotError::refused("SNAPSHOT_ATTRIBUTE_FORMAT"))?;
        require(value.len().is_multiple_of(2), "SNAPSHOT_ATTRIBUTE_FORMAT")?;
        let value = value
            .chunks_exact(2)
            .map(|pair| Ok(nibble(pair[0])? * 16 + nibble(pair[1])?))
            .collect::<Result<Vec<_>>>()?;
        result.push((OsString::from_vec(name), value));
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(result)
}
fn nibble(byte: u8) -> Result<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(SnapshotError::refused("SNAPSHOT_ATTRIBUTE_FORMAT")),
    }
}
pub(super) fn encode(entries: &[(OsString, Vec<u8>)]) -> Vec<u8> {
    let mut output = Vec::new();
    for (name, value) in entries {
        let name = name.as_os_str().as_bytes();
        output.extend_from_slice(&(name.len() as u64).to_le_bytes());
        output.extend_from_slice(name);
        output.extend_from_slice(&(value.len() as u64).to_le_bytes());
        output.extend_from_slice(value);
    }
    output
}
