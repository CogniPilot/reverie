//! Fixed /proc observation DATA. No signal, process handle or effect authority.
use super::*;
use reverie_core::decimal::UnsignedInteger;

#[derive(Clone, Eq, PartialEq)]
pub struct PreflightProcessData {
    pid: UnsignedInteger,
    start: String,
    root: [u64; 2],
    namespaces: [u64; 3],
}
pub struct PreflightProcessStat {
    pid: UnsignedInteger,
    start: String,
}
impl PreflightProcessStat {
    pub fn decode(pid: &UnsignedInteger, stat: &[u8]) -> Result<Self> {
        if pid <= &UnsignedInteger::from_u64(1) || stat.len() > 8192 {
            return Err(GpuDataError::NativeBinding);
        }
        let tail = stat
            .iter()
            .rposition(|&byte| byte == b')')
            .map(|index| &stat[index + 1..])
            .ok_or(GpuDataError::NativeBinding)?;
        let fields: Vec<_> = tail
            .split(|byte| matches!(byte, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r'))
            .filter(|field| !field.is_empty())
            .collect();
        if fields
            .first()
            .is_none_or(|value| matches!(*value, b"Z" | b"X"))
        {
            return Err(GpuDataError::NativeBinding);
        }
        let raw = fields
            .get(19)
            .filter(|raw| raw.is_ascii())
            .ok_or(GpuDataError::NativeBinding)?;
        let points: Vec<_> = raw.iter().copied().map(u32::from).collect();
        let (negative, start) =
            crate::rootless::parse_python_integer(&points).ok_or(GpuDataError::NativeBinding)?;
        let start = format!(
            "{}{}",
            if negative && !start.is_zero() {
                "-"
            } else {
                ""
            },
            start.as_str()
        );
        Ok(Self {
            pid: pid.clone(),
            start,
        })
    }
    /// Native observations are supplied separately, after this stat parse.
    /// This assembles report data, never a process or stop capability.
    pub fn with_observations(self, root: [u64; 2], namespaces: [u64; 3]) -> PreflightProcessData {
        PreflightProcessData {
            pid: self.pid,
            start: self.start,
            root,
            namespaces,
        }
    }
}
impl PreflightProcessData {
    pub fn pid(&self) -> &UnsignedInteger {
        &self.pid
    }
    pub fn equivalent(&self, other: &Self) -> bool {
        self.value().python_eq(&other.value())
    }
    pub(crate) fn value(&self) -> Value {
        Value(Node::Object(
            [
                (key("pid"), decimal(self.pid.as_str())),
                (key("startTick"), decimal(&self.start)),
                (
                    key("rootIdentity"),
                    Value(Node::Array(self.root.into_iter().map(number).collect())),
                ),
                (
                    key("namespaces"),
                    Value(Node::Object(
                        ["mnt", "pid", "user"]
                            .into_iter()
                            .zip(self.namespaces)
                            .map(|(name, inode)| (key(name), number(inode)))
                            .collect(),
                    )),
                ),
            ]
            .into(),
        ))
    }
}
fn decimal(value: &str) -> Value {
    Value(Node::Number(Number::Integer(value.into())))
}
