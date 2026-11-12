//! Read-only standalone owner GPU metadata preflight. This does not construct
//! an InstallingBroker, acquire admission, write configuration or start work.
mod initial;
mod laptop;
mod report;
use crate::{
    resource_staging::effective_config,
    worker_validation::{ValidatedWorkerSnapshot, validate_captured},
};
use reverie_contracts::{
    gpu_access::{GpuEngineInformation, PreflightEndpoint, PreflightEngineData, preflight::*},
    resource_config::ResourceIdentitySettings,
    rootless::{RootlessConfig, RootlessImage},
    worker_config::{self, EffectiveWorkerConfig},
    worker_image_switch::WorkerImageId,
};
use reverie_core::{
    device_policy::NvidiaCdiDevice, gpu_access::PhysicalGpu, ids::ProfileEmployeeId,
    operations::JournalDigest,
};
use reverie_host::{
    device_policy,
    engine_metadata::{GpuPreflightEngine, GpuPreflightQuery},
    gpu_access::{self, GpuHardware, PreflightCdiObservation},
    rootless, worker_identity,
};
use std::{
    error::Error,
    fmt,
    path::Path,
    time::{Duration, Instant},
};

pub struct PreflightRequest {
    pub employee: ProfileEmployeeId,
    pub device: NvidiaCdiDevice,
    pub image: Option<WorkerImageId>,
    pub browser: bool,
    pub cdi_digest: Option<JournalDigest>,
}
type Result<T> = std::result::Result<T, Box<dyn Error>>;
struct Observer<'a> {
    snapshot: &'a ValidatedWorkerSnapshot,
    request: &'a PreflightRequest,
    engine: &'a GpuPreflightEngine,
}
struct Initial {
    binding: PreflightBinding,
    candidate: PreflightCandidate,
    endpoint: PreflightEndpoint,
    information: GpuEngineInformation,
    cdi: PreflightCdiObservation,
    physical: PhysicalGpu,
    image: WorkerImageId,
    labels: PreflightImageLabels,
    laptop: PreflightLaptopData,
}
pub fn observe(
    config: &Path,
    request: &PreflightRequest,
    engine: GpuPreflightEngine,
) -> Result<Vec<u8>> {
    let body = (|| {
        let snapshot = load(config)?;
        let observer = Observer {
            snapshot: &snapshot,
            request,
            engine: &engine,
        };
        let initial = observer.initial()?;
        observer.finish(initial, config)
    })();
    let closed = engine.close(Instant::now() + Duration::from_secs(2));
    match (body, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(Box::new(FinalizedFailure {
            primary: Box::new(error),
            cleanup: None,
            engine: Some(Box::new(engine)),
        })),
        (Err(primary), Err(cleanup)) => Err(Box::new(FinalizedFailure {
            primary,
            cleanup: Some(Box::new(cleanup)),
            engine: Some(Box::new(engine)),
        })),
    }
}
fn load(path: &Path) -> Result<ValidatedWorkerSnapshot> {
    Ok(validate_captured(gpu_access::preflight_configuration(
        path,
    )?)?)
}
impl Observer<'_> {
    fn config(&self) -> &EffectiveWorkerConfig {
        self.snapshot.configuration()
    }
    fn grant(
        &self,
        config: &EffectiveWorkerConfig,
        binding: &PreflightBinding,
    ) -> Result<Option<NvidiaCdiDevice>> {
        let settings = ResourceIdentitySettings::capture_worker_config(config)?;
        let identity = worker_identity::storage_identity(&settings)?;
        let grants =
            device_policy::projected_gpu_grants(config, &identity, binding.current().session())?;
        Ok(grants.and_then(|grants| grants.get(binding.current().session()).cloned()))
    }
}
struct FinalizedFailure {
    primary: Box<dyn Error>,
    cleanup: Option<Box<dyn Error>>,
    // A close failure is not settlement: retain the SAME actual context and
    // its original pending native job in the returned error owner.
    engine: Option<Box<GpuPreflightEngine>>,
}
impl Drop for FinalizedFailure {
    fn drop(&mut self) {
        // An unchecked error drop cannot certify settlement or release the
        // original opaque job. Keep its actual client allocation until exit.
        if let Some(engine) = self.engine.take() {
            std::mem::forget(engine);
        }
    }
}
impl fmt::Debug for FinalizedFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("FinalizedFailure")
            .field("primary", &self.primary)
            .field("cleanup", &self.cleanup)
            .finish_non_exhaustive()
    }
}
impl fmt::Display for FinalizedFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.primary.fmt(out)?;
        if let Some(cleanup) = &self.cleanup {
            write!(out, "; cleanup: {cleanup}")?;
        }
        Ok(())
    }
}
impl Error for FinalizedFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.primary.as_ref())
    }
}
