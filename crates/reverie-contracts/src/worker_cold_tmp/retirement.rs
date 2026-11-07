//! Strict retirement metadata DATA. Neither a registration nor a reservation
//! establishes an actual kernel lease or grants namespace mutation authority.
use super::*;
use reverie_core::posix_path::PosixPath;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetainedLeaseKind {
    Lock,
    Path,
    Reservation,
    Holder,
}
pub struct RetainedLeaseName<'a> {
    key: &'a str,
    kind: RetainedLeaseKind,
}
impl<'a> RetainedLeaseName<'a> {
    /// Preserve raw decimal spelling, including leading zeroes. A normalized
    /// device/inode number would silently merge distinct registered names.
    pub fn parse(name: &'a str) -> Result<Self> {
        let (key, tail) = name.split_once('.').ok_or(ColdDataError::Lease)?;
        let (device, inode) = key.split_once('-').ok_or(ColdDataError::Lease)?;
        if !digits(device) || !digits(inode) {
            return Err(ColdDataError::Lease);
        }
        let kind = match tail {
            "lock" => RetainedLeaseKind::Lock,
            "path.json" => RetainedLeaseKind::Path,
            "reserve.json" => RetainedLeaseKind::Reservation,
            value if value.strip_suffix(".json").is_some_and(digits) => RetainedLeaseKind::Holder,
            _ => return Err(ColdDataError::Lease),
        };
        Ok(Self { key, kind })
    }
    pub fn key(&self) -> &str {
        self.key
    }
    pub fn kind(&self) -> RetainedLeaseKind {
        self.kind
    }
}
fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

pub struct RetainedLeaseRecord(Value);
impl RetainedLeaseRecord {
    /// Match json.loads(bytes, object_pairs_hook=unique), with exact integer
    /// version 1. The real filesystem owner separately checks the 65536-byte
    /// bound, regular-file custody and pinned before/after generation.
    pub fn decode(raw: &[u8]) -> Result<Self> {
        super::lease::strict_record(raw).map(Self)
    }
    pub fn reservation_state(&self, now: f64) -> Result<ColdLeaseState> {
        super::lease::state(&self.0, now)
    }
    pub fn registered_path(&self) -> Result<PosixPath> {
        let fields = object(&self.0).expect("strict retirement object");
        let text = metadata(field(fields, "path"), ColdDataError::Lease)?;
        // This is Python str.encode(), not os.fsencode(): lone surrogates,
        // including surrogateescape, refuse even on a supporting filesystem.
        let scalar = text.scalar_text().ok_or(ColdDataError::Lease)?;
        let path = PosixPath::try_new(text.codepoints()).map_err(|_| ColdDataError::Lease)?;
        if scalar.len() > 4096
            || !path.is_absolute()
            || path.codepoints() != text.codepoints()
            || text.codepoints().contains(&0)
            || path.has_parent_component()
        {
            return Err(ColdDataError::Lease);
        }
        Ok(path)
    }
}
