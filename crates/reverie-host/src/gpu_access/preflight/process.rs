//! The original standalone preflight's fixed process identity observations.
use super::*;
use reverie_contracts::gpu_access::preflight::{PreflightProcessData, PreflightProcessStat};
use reverie_core::decimal::UnsignedInteger;
use std::{fs::File, io::Read, path::PathBuf};

pub fn preflight_process(pid: &UnsignedInteger) -> Result<PreflightProcessData> {
    need(pid > &UnsignedInteger::from_u64(1), "GPU_NATIVE_PROCESS")?;
    let root = PathBuf::from(format!("/proc/{}", pid.as_str()));
    let mut file = File::open(root.join("stat"))?;
    let mut raw = Vec::new();
    let read = (&mut file)
        .take(8193)
        .read_to_end(&mut raw)
        .map(|_| ())
        .map_err(GpuHostError::from);
    finalized(read, native::close(file).map_err(Into::into))?;
    need(raw.len() <= 8192, "GPU_NATIVE_PROCESS")?;
    // Keep stat parsing before root/namespaces, as the original reader does.
    let parsed = PreflightProcessStat::decode(pid, &raw)?;
    let guest = fs::metadata(root.join("root"))?;
    let mut namespaces = [0; 3];
    for (index, name) in ["mnt", "pid", "user"].into_iter().enumerate() {
        namespaces[index] = fs::metadata(root.join("ns").join(name))?.ino();
    }
    Ok(parsed.with_observations([guest.dev(), guest.ino()], namespaces))
}
