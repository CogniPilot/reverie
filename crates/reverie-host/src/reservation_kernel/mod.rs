//! Fixed Linux reservation kernel/filesystem observations. These are snapshots,
//! not retained native grants, leases, process effects or admission authority.
mod baseline;
mod cold;
mod custody;
mod limits;
mod source_release;
mod storage;
mod targets;
pub use targets::CustodyPaths;
#[cfg(test)]
mod tests;
use crate::{ObservationError, native};
pub use limits::LimitsObservation;
use reverie_contracts::{
    kernel_accounting::{self, HostAccounting, KernelDataError},
    kernel_mounts::{MAX_MOUNT_BYTES, MountDevice, MountTable, MountTableError},
    reservation_engine::{
        ContainerRow, EngineDataError, InventoryRows, ObservedMemoryPolicy,
        ReservationConfiguration,
    },
};
use reverie_core::{decimal::UnsignedInteger, posix_path::PosixPath};
use std::os::unix::ffi::OsStrExt;
use std::{fmt, fs, io, path::Path, time::Instant};
pub use storage::StorageObservation;
const PROC: &str = "/proc";
const CGROUP: &str = "/sys/fs/cgroup";
#[derive(Debug)]
pub enum ReservationKernelError {
    Observation(ObservationError),
    Data(KernelDataError),
    Mounts(MountTableError),
    EngineData(EngineDataError),
    Baseline(reverie_contracts::reservation_baseline::BaselineDataError),
    StartData(reverie_contracts::reservation_baseline::StartDataError),
    Refused(&'static str),
}
impl ReservationKernelError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Observation(value) => value.code(),
            Self::Data(value) => value.code(),
            Self::Mounts(value) => {
                let _ = value;
                "RESERVATION_MOUNT_INVENTORY"
            }
            Self::EngineData(value) => value.code(),
            Self::Baseline(value) => value.code(),
            Self::StartData(value) => value.code(),
            Self::Refused(value) => value,
        }
    }
}
impl fmt::Display for ReservationKernelError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ReservationKernelError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Observation(error) => Some(error),
            Self::Data(error) => Some(error),
            Self::Mounts(error) => Some(error),
            Self::EngineData(error) => Some(error),
            Self::Baseline(error) => Some(error),
            Self::StartData(error) => Some(error),
            Self::Refused(_) => None,
        }
    }
}
impl From<ObservationError> for ReservationKernelError {
    fn from(value: ObservationError) -> Self {
        Self::Observation(value)
    }
}
impl From<io::Error> for ReservationKernelError {
    fn from(value: io::Error) -> Self {
        Self::Observation(value.into())
    }
}
impl From<KernelDataError> for ReservationKernelError {
    fn from(value: KernelDataError) -> Self {
        Self::Data(value)
    }
}
impl From<MountTableError> for ReservationKernelError {
    fn from(value: MountTableError) -> Self {
        Self::Mounts(value)
    }
}
impl From<EngineDataError> for ReservationKernelError {
    fn from(value: EngineDataError) -> Self {
        Self::EngineData(value)
    }
}
impl From<reverie_contracts::reservation_baseline::BaselineDataError> for ReservationKernelError {
    fn from(value: reverie_contracts::reservation_baseline::BaselineDataError) -> Self {
        Self::Baseline(value)
    }
}
impl From<reverie_contracts::reservation_baseline::StartDataError> for ReservationKernelError {
    fn from(value: reverie_contracts::reservation_baseline::StartDataError) -> Self {
        Self::StartData(value)
    }
}
type Result<T> = std::result::Result<T, ReservationKernelError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(ReservationKernelError::Refused(code))
    }
}
fn check(end: Instant) -> Result<()> {
    need(Instant::now() < end, "RESERVATION_OBSERVATION_DEADLINE")
}
fn path(value: &str) -> PosixPath {
    PosixPath::from_scalar_text(value)
}
fn join(root: &PosixPath, name: &str) -> PosixPath {
    root.join(&path(name))
}
trait Source {
    fn read(&self, path: &PosixPath, maximum: usize) -> Result<Vec<u8>>;
    fn exists(&self, path: &PosixPath) -> Result<bool>;
    fn resolve(&self, path: &PosixPath) -> Result<PosixPath>;
    fn identity(&self, path: &PosixPath) -> Result<[u64; 4]>;
    fn identity_text(&self, points: &[u32]) -> Result<[u64; 4]>;
    fn resolve_optional(&self, path: &PosixPath) -> Result<PosixPath>;
    fn location(&self, path: &PosixPath) -> Result<(UnsignedInteger, MountDevice)>;
}
struct Installed;
impl Source for Installed {
    fn read(&self, path: &PosixPath, maximum: usize) -> Result<Vec<u8>> {
        Ok(native::read_reservation(
            &native::python_path(&path.codepoints())?,
            maximum,
        )?)
    }
    fn exists(&self, path: &PosixPath) -> Result<bool> {
        match fs::symlink_metadata(native::python_path(&path.codepoints())?) {
            Ok(_) => Ok(true),
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(libc::ENOTDIR) =>
            {
                Ok(false)
            }
            Err(error) => Err(error.into()),
        }
    }
    fn resolve(&self, path: &PosixPath) -> Result<PosixPath> {
        Ok(native::resolve_strict_text(&path.codepoints())?)
    }
    fn identity(&self, path: &PosixPath) -> Result<[u64; 4]> {
        Ok(native::reservation_identity(path)?)
    }
    fn identity_text(&self, points: &[u32]) -> Result<[u64; 4]> {
        Ok(native::reservation_identity_text(points)?)
    }
    fn resolve_optional(&self, path: &PosixPath) -> Result<PosixPath> {
        Ok(native::resolve_optional_text(&path.codepoints())?)
    }
    fn location(&self, path: &PosixPath) -> Result<(UnsignedInteger, MountDevice)> {
        Ok(native::reservation_location(path)?)
    }
}
fn text(
    source: &impl Source,
    path: &PosixPath,
    max: usize,
    ascii: bool,
    end: Instant,
) -> Result<String> {
    check(end)?;
    let raw = source.read(path, max)?;
    check(end)?;
    need(!ascii || raw.is_ascii(), "RESERVATION_NATIVE_ENCODING")?;
    String::from_utf8(raw)
        .map_err(|_| ReservationKernelError::Refused("RESERVATION_NATIVE_ENCODING"))
}
fn pid_start(source: &impl Source, pid: &UnsignedInteger, end: Instant) -> Result<String> {
    need(!pid.is_zero(), "RESERVATION_NATIVE_PID")?;
    Ok(kernel_accounting::process_start(&text(
        source,
        &path(&format!("{PROC}/{}/stat", pid.as_str())),
        65536,
        true,
        end,
    )?)?)
}
fn table(source: &impl Source, end: Instant) -> Result<MountTable> {
    table_at(source, "self", end)
}
fn table_at(source: &impl Source, pid: &str, end: Instant) -> Result<MountTable> {
    table_base(source, &path(&format!("/proc/{pid}")), end)
}
fn table_base(source: &impl Source, base: &PosixPath, end: Instant) -> Result<MountTable> {
    let stat = join(base, "stat");
    let before = kernel_accounting::process_start(&text(source, &stat, 65536, false, end)?)?;
    check(end)?;
    let raw = source.read(&join(base, "mountinfo"), MAX_MOUNT_BYTES)?;
    check(end)?;
    need(raw.len() <= MAX_MOUNT_BYTES, "RESERVATION_NATIVE_BOUND")?;
    let points = native::python_text(Path::new(std::ffi::OsStr::from_bytes(&raw)));
    let table = MountTable::parse(&points)?;
    need(
        kernel_accounting::process_start(&text(source, &stat, 65536, false, end)?)? == before,
        "RESERVATION_NATIVE_PID_CHANGED",
    )?;
    Ok(table)
}
pub struct ReservationKernel;
impl Default for ReservationKernel {
    fn default() -> Self {
        Self::new()
    }
}
impl ReservationKernel {
    /// Fixed /proc observation of an original baseline process. This is data,
    /// not process ownership or permission to send any signal.
    pub fn original_process_start(
        &self,
        native: &reverie_contracts::reservation_engine::NativeLimitBinding,
        end: Instant,
    ) -> Result<String> {
        pid_start(&Installed, &native.pid()?, end)
    }
    /// Actual shared physical limits checks for memory-only recovery. The
    /// named inspection retains its legacy untyped Id; no CID is fabricated.
    pub fn verify_recovery_limits(
        &self,
        row: &reverie_contracts::worker_recovery::RecoveryInspection,
        policy: Option<&ObservedMemoryPolicy>,
        end: Instant,
    ) -> Result<()> {
        limits::verify_fields(&Installed, &row.fields_for_limits()?, policy, end)?;
        row.assert_native_result_data()?;
        Ok(())
    }
    pub fn original_target_storage(
        &self,
        paths: &reverie_store::storage_identity::StoragePaths,
        baseline: &reverie_contracts::reservation_baseline::OriginalSourceBaseline,
        end: Instant,
    ) -> Result<()> {
        source_release::target_storage(&Installed, paths, baseline, end)
    }
    pub fn original_accounts_current(
        &self,
        runtime: &reverie_contracts::reservation_baseline::OriginalRuntimeTail,
        end: Instant,
    ) -> Result<()> {
        source_release::accounts(&Installed, runtime, end)
    }
    pub fn old_source_released(
        &self,
        row: &ContainerRow,
        baseline: &reverie_contracts::reservation_baseline::OriginalSourceBaseline,
        end: Instant,
    ) -> Result<()> {
        source_release::observe(&Installed, row, baseline, end)
    }
    pub fn new() -> Self {
        Self
    }
    pub fn mount_table(&self, end: Instant) -> Result<MountTable> {
        table(&Installed, end)
    }
    pub fn host_root(&self, end: Instant) -> Result<HostAccounting> {
        host_root(&Installed, end)
    }
    pub fn limits(
        &self,
        row: &ContainerRow,
        policy: Option<&ObservedMemoryPolicy>,
        end: Instant,
    ) -> Result<LimitsObservation> {
        limits::observe(&Installed, row, policy, end)
    }
    pub fn custody_scan(
        &self,
        config: &ReservationConfiguration,
        rows: &InventoryRows,
        table: &MountTable,
        end: Instant,
    ) -> Result<()> {
        custody::scan(&Installed, config, rows, table, end)
    }
    /// Readonly scan of paths selected by an actual installing-service owner.
    /// These path facts are not admission, native effect or mount authority.
    pub fn custody_paths(
        &self,
        config: &ReservationConfiguration,
        targets: &CustodyPaths,
        rows: &InventoryRows,
        table: &MountTable,
        end: Instant,
    ) -> Result<()> {
        custody::scan_targets(&Installed, config, targets, rows, table, end)
    }
    pub fn storage(
        &self,
        config: &ReservationConfiguration,
        row: &ContainerRow,
        paths: &reverie_store::storage_identity::StoragePaths,
        end: Instant,
    ) -> Result<StorageObservation> {
        storage::observe(&Installed, config, row, paths, end)
    }
    pub fn swap_total(&self, end: Instant) -> Result<UnsignedInteger> {
        Ok(kernel_accounting::swap_total(&text(
            &Installed,
            &path("/proc/meminfo"),
            65536,
            false,
            end,
        )?)?)
    }
    /// Real read-side tail of capture_original. Fixed kernel roots are selected
    /// here; returned account/cgroup identities are DATA, never retained proof.
    pub fn original_runtime_tail(
        &self,
        row: &ContainerRow,
        limits: &reverie_contracts::reservation_engine::NativeLimitBinding,
        end: Instant,
    ) -> Result<reverie_contracts::reservation_baseline::OriginalRuntimeTail> {
        baseline::observe(&Installed, row, limits, end)
    }
}
fn host_root(source: &impl Source, end: Instant) -> Result<HostAccounting> {
    let table = table(source, end)?;
    let root = path(CGROUP);
    let mounts = table
        .rows()
        .iter()
        .filter(|row| row.point() == &root)
        .collect::<Vec<_>>();
    need(
        mounts.len() == 1 && mounts[0].root() == Some(&path("/")),
        "RESERVATION_HOST_HIERARCHY_REQUIRED",
    )?;
    let raw = text(
        source,
        &path("/proc/self/mountinfo"),
        MAX_MOUNT_BYTES,
        true,
        end,
    )?;
    let mut kinds = Vec::new();
    for line in kernel_accounting::lines(&raw) {
        let fields = kernel_accounting::words(line);
        if fields.first() == Some(&mounts[0].id().as_str()) {
            let split =
                fields
                    .iter()
                    .position(|v| *v == "-")
                    .ok_or(ReservationKernelError::Refused(
                        "RESERVATION_HOST_HIERARCHY_REQUIRED",
                    ))?;
            kinds.push(
                *fields
                    .get(split + 1)
                    .ok_or(ReservationKernelError::Refused(
                        "RESERVATION_HOST_HIERARCHY_REQUIRED",
                    ))?,
            );
        }
    }
    need(
        kinds == ["cgroup2"]
            && !source.exists(&join(&root, "memory.current"))?
            && !source.exists(&join(&root, "pids.current"))?,
        "RESERVATION_HOST_HIERARCHY_REQUIRED",
    )?;
    let controllers = text(source, &join(&root, "cgroup.controllers"), 65536, true, end)?;
    need(
        ["memory", "pids"]
            .iter()
            .all(|name| kernel_accounting::words(&controllers).contains(name)),
        "RESERVATION_HOST_CONTROLLERS_REQUIRED",
    )?;
    let groups = text(source, &path("/proc/self/cgroup"), 65536, true, end)?;
    let membership = kernel_accounting::CgroupMembership::observer(&groups)
        .map_err(|_| ReservationKernelError::Refused("RESERVATION_HOST_HIERARCHY_REQUIRED"))?;
    for name in ["memory.current", "pids.current"] {
        let value = text(
            source,
            &join(&root.join(membership.relative()), name),
            128,
            true,
            end,
        )?;
        need(
            kernel_accounting::ascii_counter(&value).is_ok(),
            "RESERVATION_HOST_OBSERVER_COUNTERS_REQUIRED",
        )?;
    }
    let facts = HostAccounting::parse(&text(source, &path("/proc/meminfo"), 65536, true, end)?)?;
    need(
        membership.matches(&text(source, &path("/proc/self/cgroup"), 65536, true, end)?),
        "RESERVATION_NATIVE_CGROUP",
    )?;
    Ok(facts)
}
