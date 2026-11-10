use super::*;
use reverie_core::device_policy::NvidiaCdiDevice;
use reverie_core::gpu_access::{GpuChoice, GpuDeviceUuid, PhysicalGpu};
use std::{
    collections::BTreeSet,
    fs::{self, DirEntry, File},
    io::Read,
    path::{Path, PathBuf},
    time::Instant,
};
const GPU_ROOT: &str = "/proc/driver/nvidia/gpus";
const MAX_INFORMATION: usize = 16384;
/// Fixed driver metadata only. No nvidia-smi/NVML, context creation or workload;
/// catalogue membership alone never supplies a grant or a native-device proof.
pub struct GpuHardware;
impl GpuHardware {
    pub fn catalogue() -> Result<Vec<GpuChoice>> {
        Driver {
            root: Path::new(GPU_ROOT),
        }
        .catalogue()
    }
    pub fn physical(device: &GpuDeviceUuid) -> Result<PhysicalGpu> {
        Driver {
            root: Path::new(GPU_ROOT),
        }
        .physical(device)
    }
    /// Standalone preflight preserves the caller's valid CDI UUID spelling;
    /// the queue's separate lowercase representation is not imposed here.
    pub fn physical_device(device: &NvidiaCdiDevice) -> Result<PhysicalGpu> {
        Driver {
            root: Path::new(GPU_ROOT),
        }
        .physical_device(device)
    }
    pub fn engine_information(
        engine: &crate::engine_metadata::ReadonlyEngine,
        end: Instant,
        cancel: &crate::engine_metadata::CancellationToken,
    ) -> Result<reverie_contracts::gpu_access::GpuEngineInformation> {
        let raw = engine
            .query(
                crate::engine_metadata::EngineQuery::GpuInformation,
                end,
                cancel,
            )
            .map_err(GpuHostError::Engine)?;
        let info = reverie_contracts::gpu_access::GpuEngineInformation::decode(raw.as_bytes())?;
        need(
            info.same_kernel(&native::kernel_release()?),
            "GPU_SAME_KERNEL_ENGINE_REQUIRED",
        )?;
        Ok(info)
    }
}
struct Driver<'a> {
    root: &'a Path,
}
impl Driver<'_> {
    fn catalogue(&self) -> Result<Vec<GpuChoice>> {
        let mut choices = Vec::new();
        for (index, entry) in fs::read_dir(self.root)?.enumerate() {
            let entry = information_entry(entry?, index, 32)?;
            let device = PhysicalGpu::catalogue_uuid(&information(&entry)?)?;
            let facts = self.physical(&device)?;
            let model = facts
                .model()
                .chars()
                .map(ascii_model_character)
                .take(96)
                .collect();
            choices.push(GpuChoice::try_new(device, model)?);
        }
        need(
            choices
                .iter()
                .map(GpuChoice::device)
                .collect::<BTreeSet<_>>()
                .len()
                == choices.len(),
            "GPU_HARDWARE_AMBIGUOUS",
        )?;
        choices.sort_by(|left, right| left.device().cmp(right.device()));
        Ok(choices)
    }
    fn physical(&self, device: &GpuDeviceUuid) -> Result<PhysicalGpu> {
        self.physical_device(&device.device())
    }
    fn physical_device(&self, device: &NvidiaCdiDevice) -> Result<PhysicalGpu> {
        let mut selected = Vec::new();
        for (index, entry) in fs::read_dir(self.root)?.enumerate() {
            let entry = information_entry(entry?, index, 64)?;
            if let Some(value) = PhysicalGpu::selected(&information(&entry)?, device)? {
                selected.push(value);
            }
        }
        need(selected.len() == 1, "GPU_HARDWARE_UNAVAILABLE")?;
        Ok(selected.pop().expect("one selected physical GPU"))
    }
}
fn ascii_model_character(point: char) -> char {
    if (' '..='~').contains(&point) {
        point
    } else {
        '?'
    }
}
fn information_entry(entry: DirEntry, index: usize, maximum: usize) -> Result<PathBuf> {
    // Scandir/ReadDir enumeration's normal close has no fallible source API;
    // information file descriptors below always use checked finalization.
    need(
        index < maximum && entry.file_type()?.is_dir(),
        "GPU_HARDWARE_UNAVAILABLE",
    )?;
    Ok(entry.path().join("information"))
}
fn information(path: &Path) -> Result<String> {
    // Proc information files report zero size. Source bounds actual read bytes
    // instead and follows the fixed information leaf; don't borrow CDI policy.
    let mut file = File::open(path)?;
    let mut raw = Vec::new();
    let body = (|| {
        (&mut file)
            .take((MAX_INFORMATION + 1) as u64)
            .read_to_end(&mut raw)?;
        need(raw.len() <= MAX_INFORMATION, "GPU_HARDWARE_UNAVAILABLE")?;
        String::from_utf8(raw).map_err(|_| GpuHostError::Refused("GPU_HARDWARE_UNAVAILABLE"))
    })();
    finalized(body, native::close(file).map_err(Into::into))
}
