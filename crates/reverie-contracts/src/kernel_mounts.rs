//! Exact worker_cold_tmp mount-table data. Parsing establishes no native mount
//! custody; the host must bracket reads with the actual namespace PID start.
use reverie_core::{decimal::UnsignedInteger, posix_path::PosixPath, worker_schema::MountTarget};
use std::{collections::BTreeSet, fmt};
pub const MAX_MOUNT_BYTES: usize = 1 << 20;
pub const MAX_VISIBLE_MOUNT_BYTES: usize = 2 << 20;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MountTableError;
impl fmt::Display for MountTableError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("RESERVATION_MOUNT_INVENTORY")
    }
}
impl std::error::Error for MountTableError {}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MountDevice {
    major: UnsignedInteger,
    minor: UnsignedInteger,
}
impl MountDevice {
    pub fn from_native(major: u64, minor: u64) -> Self {
        Self {
            major: UnsignedInteger::from_u64(major),
            minor: UnsignedInteger::from_u64(minor),
        }
    }
    pub fn major(&self) -> &UnsignedInteger {
        &self.major
    }
    pub fn minor(&self) -> &UnsignedInteger {
        &self.minor
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MountRow {
    id: UnsignedInteger,
    parent: Option<UnsignedInteger>,
    device: MountDevice,
    root: Option<PosixPath>,
    point: PosixPath,
    filesystem: Vec<u32>,
}
impl MountRow {
    pub fn id(&self) -> &UnsignedInteger {
        &self.id
    }
    pub fn parent_id(&self) -> Option<&UnsignedInteger> {
        self.parent.as_ref()
    }
    pub fn device(&self) -> &MountDevice {
        &self.device
    }
    pub fn root(&self) -> Option<&PosixPath> {
        self.root.as_ref()
    }
    pub fn point(&self) -> &PosixPath {
        &self.point
    }
    /// Kernel DATA only; callers still prove actual FD/device/process custody.
    pub fn filesystem_is(&self, name: &str) -> bool {
        self.filesystem
            .iter()
            .copied()
            .eq(name.chars().map(u32::from))
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MountTable {
    rows: Vec<MountRow>,
}
impl MountTable {
    /// Input is Python fsdecoded/surrogateescaped text, with its original raw
    /// byte bound enforced by the native reader. Retain source row order.
    pub fn parse(points: &[u32]) -> Result<Self, MountTableError> {
        let lines = split_lines(points);
        let mut rows = Vec::new();
        let mut ids = BTreeSet::new();
        for line in lines {
            if rows.len() >= 8192 || line.len() > 16384 {
                return Err(MountTableError);
            }
            let fields = words(line);
            let split = fields
                .iter()
                .position(|value| *value == [45])
                .ok_or(MountTableError)?;
            if split < 6 || fields.len() < split + 4 {
                return Err(MountTableError);
            }
            let id = integer(fields[0])?;
            if !ids.insert(id.clone()) {
                return Err(MountTableError);
            }
            let device = fields[2].split(|&point| point == 58).collect::<Vec<_>>();
            if device.len() != 2 {
                return Err(MountTableError);
            }
            let device = MountDevice {
                major: integer(device[0])?,
                minor: integer(device[1])?,
            };
            let root = if fields[3].first() == Some(&47) {
                Some(decode_path(fields[3])?)
            } else {
                None
            };
            rows.push(MountRow {
                id,
                parent: integer(fields[1]).ok(),
                device,
                root,
                point: decode_path(fields[4])?,
                filesystem: fields[split + 1].to_vec(),
            });
        }
        Ok(Self { rows })
    }
    pub fn rows(&self) -> &[MountRow] {
        &self.rows
    }
}

/// Mount points visible in the observer's own namespace. Offline store
/// custody uses the mount point and does not interpret mount lineage or the
/// filesystem-relative root field.
pub fn visible_mount_points(raw: &[u8]) -> Result<Vec<PosixPath>, MountTableError> {
    if raw.len() > MAX_VISIBLE_MOUNT_BYTES {
        return Err(MountTableError);
    }
    let text = std::str::from_utf8(raw).map_err(|_| MountTableError)?;
    let points = text.chars().map(u32::from).collect::<Vec<_>>();
    let lines = split_lines(&points);
    if lines.len() > 4096 {
        return Err(MountTableError);
    }
    lines.into_iter().map(visible_mount_point).collect()
}

fn visible_mount_point(line: &[u32]) -> Result<PosixPath, MountTableError> {
    let fields = words(line);
    if fields.len() < 10
        || !fields[6..].contains(&[45].as_slice())
        || !fields[..2]
            .iter()
            .all(|id| id.iter().all(|&cp| crate::rootless::is_digit(cp)))
    {
        return Err(MountTableError);
    }
    decode_path(fields[4])
}
fn integer(points: &[u32]) -> Result<UnsignedInteger, MountTableError> {
    crate::rootless::parse_python_digits(points).ok_or(MountTableError)
}
/// Original _mount_path, also used for proc reference paths. Parsing supplies
/// only lexical coordinates; actual namespace and inode custody stay native.
pub fn decode_path(raw: &[u32]) -> Result<PosixPath, MountTableError> {
    let mut points = Vec::new();
    let mut offset = 0;
    while offset < raw.len() {
        let point = raw[offset];
        if point == 92 {
            let value = raw.get(offset + 1..offset + 4).ok_or(MountTableError)?;
            points.push(match value {
                [48, 52, 48] => 32,
                [48, 49, 49] => 9,
                [48, 49, 50] => 10,
                [49, 51, 52] => 92,
                _ => return Err(MountTableError),
            });
            offset += 4;
        } else {
            points.push(point);
            offset += 1;
        }
    }
    if points.contains(&0) {
        return Err(MountTableError);
    }
    MountTarget::try_new(points.clone()).map_err(|_| MountTableError)?;
    PosixPath::try_new(&points).map_err(|_| MountTableError)
}
pub(crate) fn python_space(point: u32) -> bool {
    matches!(point,9..=13|28..=32|0x85|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000)
}
pub(crate) fn words(points: &[u32]) -> Vec<&[u32]> {
    points
        .split(|&point| python_space(point))
        .filter(|part| !part.is_empty())
        .collect()
}
pub(crate) fn split_lines(points: &[u32]) -> Vec<&[u32]> {
    if points.is_empty() {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut begin = 0;
    let mut offset = 0;
    while offset < points.len() {
        if matches!(points[offset],10..=13|28..=30|0x85|0x2028|0x2029) {
            result.push(&points[begin..offset]);
            let previous = points[offset];
            offset += 1;
            if previous == 13 && points.get(offset) == Some(&10) {
                offset += 1;
            }
            begin = offset;
        } else {
            offset += 1;
        }
    }
    if begin < points.len() {
        result.push(&points[begin..]);
    }
    result
}
