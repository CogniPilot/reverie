//! Actual owner-local queued GPU control. No device workload/start/stop exists
//! here; pending publication and actual admitted file/state producers own the
//! transition. Public transport must still authenticate its real owner UID.
use super::*;
mod apply;
mod platform;
mod publication;
mod request;
mod status;
mod website;
use website::WebsiteGpu;
#[cfg(test)]
mod tests;
use platform::Platform;
pub(crate) use publication::PublishedGpu;
pub(super) use publication::TransitionRecord;
use reverie_contracts::{
    gpu_access::{self, GpuCommand, GpuCurrentEmployee, GpuEmployeeSelector},
    worker_config::{self, EffectiveWorkerConfig},
};
use reverie_core::{
    gpu_access::{GpuBinding, GpuDeviceUuid, GpuQueuedRequest, GpuRequestDocument, GpuStatusData},
    ids::ProfileSessionId,
};
use reverie_host::gpu_access::{GpuControlFiles, GpuFileStamp};
use std::time::Duration;

struct Service<'a, P> {
    gate: &'a ReservationGate,
    platform: P,
}
enum Employee {
    Selector(GpuEmployeeSelector),
    Checked(JournalId),
}
impl Employee {
    fn resolve(&self) -> Result<JournalId> {
        match self {
            Self::Selector(value) => Ok(value.employee_id()?),
            Self::Checked(value) => Ok(value.clone()),
        }
    }
}
impl ReservationGate {
    pub(crate) fn gpu_command(
        &self,
        command: GpuCommand,
        runtime: &reverie_host::worker_runtime::WorkerRuntime,
    ) -> Result<GpuStatusData> {
        let service = Service {
            gate: self,
            platform: platform::Installed {
                engine: runtime.readonly(),
                cancel: runtime.cancellation(),
            },
        };
        service.source_required()?;
        let end = Instant::now() + Duration::from_secs(30);
        match command {
            GpuCommand::Status(employee) => service.status(Employee::Selector(employee), end),
            GpuCommand::Request { employee, intent } => service.request(employee, intent, end),
        }
    }
    pub(crate) fn gpu_cold(
        &self,
        session: &ProfileSessionId,
        runtime: &reverie_host::worker_runtime::WorkerRuntime,
    ) -> Result<()> {
        Service {
            gate: self,
            platform: platform::Installed {
                engine: runtime.readonly(),
                cancel: runtime.cancellation(),
            },
        }
        .cold(session)
    }
}
impl<P: Platform> Service<'_, P> {
    fn source_required(&self) -> Result<&std::path::Path> {
        self.gate
            .inner
            .source_path
            .as_deref()
            .ok_or(GateError::Refused("GPU_OWNER_CONTROL_UNAVAILABLE"))
    }
    fn files(&self, config: &EffectiveWorkerConfig) -> Result<GpuControlFiles> {
        Ok(GpuControlFiles::capture(self.source_required()?, config))
    }
    fn bounds(end: Instant) -> AdmissionBounds {
        AdmissionBounds {
            operation: Some(end),
            entry: None,
        }
    }
    fn private_current(
        &self,
        files: &GpuControlFiles,
        config: &EffectiveWorkerConfig,
    ) -> Result<GpuFileStamp> {
        let current = files.read_configuration()?;
        need(
            gpu_access::private_config_matches(config, current.metadata()),
            "GPU_CONFIG_CHANGED",
        )?;
        Ok(current.stamp().clone())
    }
    fn requests(
        &self,
        files: &GpuControlFiles,
    ) -> Result<(GpuRequestDocument, Option<GpuFileStamp>)> {
        match files.read_requests()? {
            None => Ok((GpuRequestDocument::empty(), None)),
            Some(read) => Ok((
                gpu_access::decode_requests(read.metadata())?,
                Some(read.stamp().clone()),
            )),
        }
    }
    fn binding(
        &self,
        config: &EffectiveWorkerConfig,
        current: &GpuCurrentEmployee,
    ) -> Result<GpuBinding> {
        let policy =
            crate::resource_staging::effective_config(config.clone(), current.data().session())?;
        Ok(gpu_access::current_binding(
            config,
            current,
            &worker_config::policy_digest(&policy),
        )?)
    }
}
