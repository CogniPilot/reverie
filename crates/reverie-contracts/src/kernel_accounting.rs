//! Captured kernel accounting formats. These are data, never hierarchy/cgroup
//! qualification; the native observer supplies fixed paths and read brackets.
use reverie_core::{decimal::UnsignedInteger, posix_path::PosixPath};
use std::fmt;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KernelDataError {
    Pid,
    Cgroup,
    HostAccounting,
    ControllerLimit,
    SwapUnavailable,
    SwapCapacity,
    IntegerConversion,
    OldCgroupEvents,
}
impl KernelDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Pid => "RESERVATION_NATIVE_PID",
            Self::Cgroup => "RESERVATION_NATIVE_CGROUP",
            Self::HostAccounting => "RESERVATION_HOST_ACCOUNTING",
            Self::ControllerLimit => "RESERVATION_NATIVE_CGROUP_LIMIT",
            Self::SwapUnavailable => "Host swap capacity is unavailable",
            Self::SwapCapacity => "Laptop swap pool exceeds actual host swap capacity",
            Self::IntegerConversion => "PYTHON_INTEGER_CONVERSION",
            Self::OldCgroupEvents => "RESOURCE_NATIVE_OLD_CGROUP_UNKNOWN",
        }
    }
}
impl fmt::Display for KernelDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for KernelDataError {}
/// Exact facts parsing after the native owner's bounded ASCII read. Empty
/// facts/missing populated is a negative observation, not malformed syntax.
pub fn old_cgroup_unpopulated(raw: &str) -> Result<bool, KernelDataError> {
    let mut facts = std::collections::BTreeMap::new();
    for line in lines(raw) {
        let fields = words(line);
        if fields.len() != 2 || facts.contains_key(fields[0]) {
            return Err(KernelDataError::OldCgroupEvents);
        }
        let value = UnsignedInteger::parse(fields[1]).ok_or(KernelDataError::OldCgroupEvents)?;
        facts.insert(fields[0], value);
    }
    Ok(facts.get("populated").is_some_and(UnsignedInteger::is_zero))
}
pub fn process_start(stat: &str) -> Result<String, KernelDataError> {
    let (_, tail) = stat.rsplit_once(')').ok_or(KernelDataError::Pid)?;
    words(tail)
        .get(19)
        .map(|value| (*value).to_owned())
        .ok_or(KernelDataError::Pid)
}
pub struct HostAccounting {
    total: UnsignedInteger,
    available: UnsignedInteger,
}
impl HostAccounting {
    pub fn parse(meminfo: &str) -> Result<Self, KernelDataError> {
        let mut total = None;
        let mut available = None;
        for line in lines(meminfo) {
            let (name, rest) = line.split_once(':').unwrap_or((line, ""));
            let target = match name {
                "MemTotal" => &mut total,
                "MemAvailable" => &mut available,
                _ => continue,
            };
            let fields = words(rest);
            if target.is_some() || fields.len() != 2 || fields[1] != "kB" || fields[0].len() > 16 {
                return Err(KernelDataError::HostAccounting);
            }
            *target = Some(
                decimal(fields[0])
                    .map_err(|_| KernelDataError::HostAccounting)?
                    .times(1024),
            );
        }
        let total = total.ok_or(KernelDataError::HostAccounting)?;
        let available = available.ok_or(KernelDataError::HostAccounting)?;
        if available.is_zero() || available > total {
            return Err(KernelDataError::HostAccounting);
        }
        Ok(Self { total, available })
    }
    pub fn total(&self) -> &UnsignedInteger {
        &self.total
    }
    pub fn available(&self) -> &UnsignedInteger {
        &self.available
    }
}
pub struct CgroupMembership {
    relative: PosixPath,
    lines: Vec<String>,
}
impl CgroupMembership {
    pub fn container(raw: &str) -> Result<Self, KernelDataError> {
        Self::parse(raw, false)
    }
    pub fn observer(raw: &str) -> Result<Self, KernelDataError> {
        Self::parse(raw, true)
    }
    fn parse(raw: &str, observer: bool) -> Result<Self, KernelDataError> {
        let lines = lines(raw);
        if lines.len() != 1 || !lines[0].starts_with("0::/") {
            return Err(KernelDataError::Cgroup);
        }
        let relative = PosixPath::from_scalar_text(&lines[0][4..]);
        if relative.is_absolute()
            || relative.has_parent_component()
            || (observer && relative.codepoints() == [46])
        {
            return Err(KernelDataError::Cgroup);
        }
        Ok(Self {
            relative,
            lines: lines.into_iter().map(str::to_owned).collect(),
        })
    }
    pub fn relative(&self) -> &PosixPath {
        &self.relative
    }
    pub fn matches(&self, raw: &str) -> bool {
        self.lines.iter().map(String::as_str).eq(lines(raw))
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControllerLimit {
    Unlimited,
    Finite(UnsignedInteger),
}
impl ControllerLimit {
    pub fn memory_or_tasks(raw: &str) -> Result<Self, KernelDataError> {
        Self::parse(raw, false)
    }
    pub fn swap(raw: &str) -> Result<Self, KernelDataError> {
        Self::parse(raw, true)
    }
    fn parse(raw: &str, allow_zero: bool) -> Result<Self, KernelDataError> {
        let raw = strip(raw);
        if raw == "max" {
            return Ok(Self::Unlimited);
        }
        let value = decimal(raw)?;
        if value.is_zero() && !allow_zero {
            return Err(KernelDataError::ControllerLimit);
        }
        Ok(Self::Finite(value))
    }
}
pub fn ascii_counter(raw: &str) -> Result<UnsignedInteger, KernelDataError> {
    decimal(strip(raw))
}
pub fn mount_id(fdinfo: &str) -> Result<UnsignedInteger, KernelDataError> {
    let rows = lines(fdinfo)
        .into_iter()
        .filter_map(|line| line.strip_prefix("mnt_id:"))
        .collect::<Vec<_>>();
    if rows.len() != 1 {
        return Err(KernelDataError::Cgroup);
    }
    crate::rootless::parse_python_digits(&strip(rows[0]).chars().map(u32::from).collect::<Vec<_>>())
        .ok_or(KernelDataError::Cgroup)
}
pub fn swap_total(meminfo: &str) -> Result<UnsignedInteger, KernelDataError> {
    let mut total = None;
    let mut count = 0;
    for line in lines(meminfo) {
        if line.starts_with("SwapTotal:") {
            let fields = words(line);
            if fields.len() != 3 || fields[2] != "kB" {
                return Err(KernelDataError::SwapUnavailable);
            }
            let value = decimal(fields[1]).map_err(|_| KernelDataError::SwapUnavailable)?;
            if fields[1].len() > crate::legacy_json::DEFAULT_INT_MAX_DIGITS {
                return Err(KernelDataError::IntegerConversion);
            }
            count += 1;
            total = Some(value.times(1024));
        }
    }
    if count != 1 {
        return Err(KernelDataError::SwapCapacity);
    }
    total.ok_or(KernelDataError::SwapCapacity)
}
pub fn strip(text: &str) -> &str {
    text.trim_matches(|ch| crate::kernel_mounts::python_space(u32::from(ch)))
}
fn decimal(text: &str) -> Result<UnsignedInteger, KernelDataError> {
    UnsignedInteger::parse(text).ok_or(KernelDataError::ControllerLimit)
}
pub fn words(text: &str) -> Vec<&str> {
    text.split(|ch| crate::kernel_mounts::python_space(u32::from(ch)))
        .filter(|value| !value.is_empty())
        .collect()
}
pub fn lines(text: &str) -> Vec<&str> {
    crate::reservation_engine::splitlines(text)
}
