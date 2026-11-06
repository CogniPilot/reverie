//! Exact worker_cold_tmp mount-table data. Parsing establishes no native mount
//! custody; the host must bracket reads with the actual namespace PID start.
use reverie_core::{decimal::UnsignedInteger, posix_path::PosixPath, worker_schema::MountTarget};
use std::{collections::BTreeSet, fmt};
pub const MAX_MOUNT_BYTES: usize = 1 << 20;
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
    device: MountDevice,
    root: Option<PosixPath>,
    point: PosixPath,
}
impl MountRow {
    pub fn id(&self) -> &UnsignedInteger {
        &self.id
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
                Some(path(fields[3])?)
            } else {
                None
            };
            rows.push(MountRow {
                id,
                device,
                root,
                point: path(fields[4])?,
            });
        }
        Ok(Self { rows })
    }
    pub fn rows(&self) -> &[MountRow] {
        &self.rows
    }
}
fn integer(points: &[u32]) -> Result<UnsignedInteger, MountTableError> {
    crate::rootless::parse_python_digits(points).ok_or(MountTableError)
}
fn path(raw: &[u32]) -> Result<PosixPath, MountTableError> {
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
