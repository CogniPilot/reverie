use super::*;
use reverie_core::{decimal::UnsignedInteger, gpu_access::PhysicalGpu};
use std::{
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::PathBuf,
};
/// Fixed physical/process/node DATA proof for status only, after the caller's
/// same-origin NativeObserver::limits. This does not open the device or grant
/// GPU/start permission. PID birth is observed before and after both stats.
pub fn observe_active_device(pid: &UnsignedInteger, physical: &PhysicalGpu) -> Result<()> {
    need(!pid.is_zero(), "GPU_NATIVE_DEVICE_UNKNOWN")?;
    let before = birth(pid)?;
    let name = format!("nvidia{}", physical.minor());
    let host = fs::metadata(PathBuf::from("/dev").join(&name))?;
    let guest = fs::metadata(PathBuf::from(format!("/proc/{}/root/dev", pid.as_str())).join(name))?;
    need(
        host.file_type().is_char_device()
            && guest.file_type().is_char_device()
            && host.rdev() == guest.rdev()
            && birth(pid)? == before,
        "GPU_NATIVE_DEVICE_UNKNOWN",
    )
}
fn birth(pid: &UnsignedInteger) -> Result<String> {
    let raw = native::read_reservation(
        &PathBuf::from(format!("/proc/{}/stat", pid.as_str())),
        65536,
    )?;
    need(raw.is_ascii(), "GPU_NATIVE_DEVICE_UNKNOWN")?;
    let text = std::str::from_utf8(&raw).expect("checked ASCII");
    reverie_contracts::kernel_accounting::process_start(text)
        .map_err(|_| GpuHostError::Refused("GPU_NATIVE_DEVICE_UNKNOWN"))
}
