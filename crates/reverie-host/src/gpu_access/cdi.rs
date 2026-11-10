use super::*;
#[cfg(test)]
mod tests;
use reverie_contracts::{
    gpu_access::preflight::PreflightCdiData,
    gpu_access::{CdiDocument, CdiSelectedEdits, GpuEngineInformation},
    storage_identity::MetadataText,
};
use reverie_core::device_policy::NvidiaCdiDevice;
use reverie_core::{gpu_access::GpuDeviceUuid, posix_path::PosixPath};
use std::{
    fs,
    io::Read,
    os::unix::fs::MetadataExt,
    path::Path,
    time::{Duration, Instant},
};
const MAX_SPEC_BYTES: usize = 262144;
const MAX_TOTAL_BYTES: usize = 1 << 20;
#[derive(Clone, Debug)]
pub struct CdiObservation {
    path: PosixPath,
    stamp: GpuFileStamp,
    sha256: String,
    edits: CdiSelectedEdits,
}
impl CdiObservation {
    pub fn path(&self) -> &PosixPath {
        &self.path
    }
    pub fn stamp(&self) -> &GpuFileStamp {
        &self.stamp
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn edits(&self) -> &CdiSelectedEdits {
        &self.edits
    }
    /// Source cdi_device's complete projected result equality. The raw digest
    /// binds ignored fields too; the separately captured terminal stamp must
    /// not silently become an extra field in this data comparison.
    pub fn equivalent(&self, other: &Self) -> bool {
        self.path == other.path && self.sha256 == other.sha256 && self.edits == other.edits
    }
    pub fn assert_current(&self) -> Result<()> {
        let path = native::python_path(&self.path.codepoints())?;
        need(
            GpuFileStamp::observe(&path)? == self.stamp,
            "GPU_CDI_OR_HARDWARE_CHANGED",
        )
    }
}
impl GpuHardware {
    pub fn cdi(
        info: &GpuEngineInformation,
        device: &GpuDeviceUuid,
        end: Instant,
    ) -> Result<CdiObservation> {
        Self::cdi_device(info, &device.device(), end)
    }
    /// Exact standalone device spelling. This is still only the existing
    /// numeric/edit observation; the complete preflight report is separate.
    pub fn cdi_device(
        info: &GpuEngineInformation,
        device: &NvidiaCdiDevice,
        end: Instant,
    ) -> Result<CdiObservation> {
        observe::<Standard>(info, device, end)
    }
    pub fn preflight_cdi(
        info: &GpuEngineInformation,
        device: &NvidiaCdiDevice,
        end: Instant,
    ) -> Result<PreflightCdiObservation> {
        observe::<Complete>(info, device, end)
    }
}
pub struct PreflightCdiObservation {
    observation: CdiObservation,
    data: PreflightCdiData,
}
impl PreflightCdiObservation {
    pub fn observation(&self) -> &CdiObservation {
        &self.observation
    }
    pub fn data(&self) -> &PreflightCdiData {
        &self.data
    }
    pub fn equivalent(&self, other: &Self) -> bool {
        self.observation.equivalent(&other.observation)
    }
}
trait Selection {
    type Output;
    fn select(
        document: CdiDocument,
        device: &NvidiaCdiDevice,
        source: Source,
        raw: &[u8],
    ) -> Result<Option<Self::Output>>;
}
struct Source {
    path: PosixPath,
    stamp: GpuFileStamp,
}
struct Standard;
struct Complete;
impl Source {
    fn observation(self, edits: CdiSelectedEdits, sha256: String) -> CdiObservation {
        CdiObservation {
            path: self.path,
            stamp: self.stamp,
            sha256,
            edits,
        }
    }
}
impl Selection for Standard {
    type Output = CdiObservation;
    fn select(
        document: CdiDocument,
        device: &NvidiaCdiDevice,
        source: Source,
        raw: &[u8],
    ) -> Result<Option<Self::Output>> {
        Ok(document
            .selected(device)?
            .map(|edits| source.observation(edits, reverie_contracts::gpu_access::cdi_digest(raw))))
    }
}
impl Selection for Complete {
    type Output = PreflightCdiObservation;
    fn select(
        document: CdiDocument,
        device: &NvidiaCdiDevice,
        source: Source,
        raw: &[u8],
    ) -> Result<Option<Self::Output>> {
        let Some(projection) = document.into_preflight(device)? else {
            return Ok(None);
        };
        let path = MetadataText::from_python_text(
            reverie_core::PythonText::try_new(source.path.codepoints())
                .expect("native path codepoints"),
        );
        let sha256 = reverie_contracts::gpu_access::cdi_digest(raw);
        let digest =
            reverie_core::operations::JournalDigest::parse(&sha256).map_err(GpuDataError::from)?;
        let edits = projection.edits().clone();
        Ok(Some(PreflightCdiObservation {
            observation: source.observation(edits, sha256),
            data: PreflightCdiData::new(path, digest, projection),
        }))
    }
}
fn observe<S: Selection>(
    info: &GpuEngineInformation,
    device: &NvidiaCdiDevice,
    end: Instant,
) -> Result<S::Output> {
    let end = end.min(Instant::now() + Duration::from_secs(5));
    let mut count = 0;
    let mut total = 0;
    let mut selected = Vec::new();
    for directory in info.cdi_directories()? {
        let Some(directory) = directory_path(directory?)? else {
            continue;
        };
        let entries = entries(&directory, end, &mut count)?;
        selected.extend(selected_entries::<S>(entries, device, end, &mut total)?);
    }
    need(selected.len() == 1, "GPU_CDI_MISSING_OR_AMBIGUOUS")?;
    Ok(selected.pop().expect("one selected CDI entry"))
}
fn selected_entries<S: Selection>(
    entries: Vec<PosixPath>,
    device: &NvidiaCdiDevice,
    end: Instant,
    total: &mut usize,
) -> Result<Vec<S::Output>> {
    let mut selected = Vec::new();
    for path in entries {
        let native_path = native::python_path(&path.codepoints())?;
        if !matches!(
            native_path.extension().and_then(|value| value.to_str()),
            Some("json" | "yaml" | "yml")
        ) {
            continue;
        }
        let (raw, stamp) = specification(&native_path)?;
        *total += raw.len();
        need(
            *total <= MAX_TOTAL_BYTES && Instant::now() < end,
            "GPU_CDI_BOUND_OR_DEADLINE",
        )?;
        let document = CdiDocument::decode(&raw)?;
        let source = Source { path, stamp };
        if let Some(observation) = S::select(document, device, source, &raw)? {
            selected.push(observation);
        }
    }
    Ok(selected)
}
fn directory_path(value: MetadataText) -> Result<Option<PosixPath>> {
    let path = PosixPath::try_new(value.codepoints())
        .map_err(|_| GpuHostError::Refused("GPU_CDI_DIRECTORY"))?;
    need(
        path.is_absolute()
            && !path
                .codepoints()
                .split(|&point| point == 47)
                .any(|part| part == [46, 46]),
        "GPU_CDI_DIRECTORY",
    )?;
    let native_path = native::python_path(&path.codepoints())?;
    match fs::metadata(native_path) {
        Ok(_) => {}
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP | libc::EBADF)
            ) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    }
    let path = native::resolve_strict_text(&path.codepoints())?;
    let info = fs::metadata(native::python_path(&path.codepoints())?)?;
    need(
        info.is_dir() && [0, native::uid()].contains(&info.uid()) && info.mode() & 0o022 == 0,
        "GPU_CDI_DIRECTORY_CUSTODY",
    )?;
    Ok(Some(path))
}
fn entries(directory: &PosixPath, end: Instant, count: &mut usize) -> Result<Vec<PosixPath>> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(native::python_path(&directory.codepoints())?)? {
        let entry = entry?;
        *count += 1;
        need(
            *count <= 128 && Instant::now() < end,
            "GPU_CDI_BOUND_OR_DEADLINE",
        )?;
        let name = PosixPath::try_new(&native::python_text(Path::new(&entry.file_name())))
            .expect("native filename text");
        paths.push(directory.join(&name));
    }
    Ok(paths)
}
fn specification(path: &Path) -> Result<(Vec<u8>, GpuFileStamp)> {
    let mut file = native::open_at(
        libc::AT_FDCWD,
        path.as_os_str(),
        libc::O_RDONLY | libc::O_NONBLOCK,
    )?;
    let result = (|| {
        let before = file.metadata()?;
        need(
            before.is_file()
                && [0, native::uid()].contains(&before.uid())
                && before.nlink() == 1
                && before.mode() & 0o022 == 0
                && before.len() <= MAX_SPEC_BYTES as u64,
            "GPU_CDI_SPECIFICATION_CUSTODY",
        )?;
        let mut raw = Vec::new();
        (&mut file)
            .take((MAX_SPEC_BYTES + 1) as u64)
            .read_to_end(&mut raw)?;
        need(raw.len() <= MAX_SPEC_BYTES, "GPU_CDI_SPECIFICATION_BOUND")?;
        let stamp = GpuFileStamp::of(&before);
        need(
            raw.len() as u64 == before.len()
                && GpuFileStamp::of(&file.metadata()?) == stamp
                && GpuFileStamp::observe(path)? == stamp,
            "GPU_CDI_SPECIFICATION_CHANGED",
        )?;
        Ok((raw, stamp))
    })();
    finalized(result, native::close(file).map_err(Into::into))
}
