//! Metadata-only equivalent of the worker factory's static ELF64 check.
use crate::{Result, refused};

pub fn require_static_elf64(raw: &[u8], machine: u16) -> Result<()> {
    need(
        (64..=16 << 20).contains(&raw.len()) && raw.starts_with(b"\x7fELF\x02\x01\x01"),
        "static little-endian ELF64 toolkit required",
    )?;
    let count = u16_at(raw, 56)?;
    let offset = usize::try_from(u64_at(raw, 32)?)?;
    need(
        matches!(machine, 62 | 183)
            && matches!(u16_at(raw, 16)?, 2 | 3)
            && u16_at(raw, 18)? == machine
            && u32_at(raw, 20)? == 1
            && u16_at(raw, 52)? == 64
            && u16_at(raw, 54)? == 56
            && (1..=1024).contains(&count)
            && offset
                .checked_add(56 * usize::from(count))
                .is_some_and(|end| end <= raw.len()),
        "toolkit ELF program metadata differs",
    )?;
    let mut load = false;
    for index in 0..usize::from(count) {
        let header = offset + 56 * index;
        let kind = u32_at(raw, header)?;
        let start = usize::try_from(u64_at(raw, header + 8)?)?;
        let size = usize::try_from(u64_at(raw, header + 32)?)?;
        need(
            start <= raw.len() && size <= raw.len() - start && kind != 3,
            "toolkit interpreter or segment bounds refused",
        )?;
        load |= kind == 1;
        if kind == 2 {
            dynamic(&raw[start..start + size])?;
        }
    }
    need(load, "toolkit ELF load segment required")
}
fn dynamic(raw: &[u8]) -> Result<()> {
    need(
        raw.len().is_multiple_of(16),
        "toolkit dynamic metadata malformed",
    )?;
    for row in raw.chunks_exact(16) {
        let tag = u64_at(row, 0)?;
        need(tag != 1, "toolkit dynamic dependency refused")?;
        if tag == 0 {
            break;
        }
    }
    Ok(())
}
fn bytes<const N: usize>(raw: &[u8], offset: usize) -> Result<[u8; N]> {
    let end = offset
        .checked_add(N)
        .ok_or_else(|| refused("ELF offset overflow"))?;
    raw.get(offset..end)
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| refused("ELF metadata truncated"))
}
fn u16_at(raw: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(bytes(raw, offset)?))
}
fn u32_at(raw: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(bytes(raw, offset)?))
}
fn u64_at(raw: &[u8], offset: usize) -> Result<u64> {
    Ok(u64::from_le_bytes(bytes(raw, offset)?))
}
fn need(value: bool, reason: &str) -> Result<()> {
    if value { Ok(()) } else { Err(refused(reason)) }
}
