//! Fixed read-only engine queries over one service-owned supervised client.
//! Bootstrap, rows and diagnostics are protected data, never wire-selected
//! commands, owner authorization, engine identity or mutation permission.
mod bootstrap;
mod control;
#[cfg(test)]
mod installed_context_tests;
mod owner;
#[cfg(test)]
pub(crate) mod tests;
pub use bootstrap::EngineBootstrap;
pub use control::{CancellationToken, ReadonlyEngine};
pub use owner::MetadataQueryOwner;
use reverie_core::ids::ContainerId;
use std::{ffi::OsString, fmt};

// Broker.run_engine delegates to worker_cleanup.run_client's combined 4 MiB
// subprocess bound. The reservation JSON/schema decoder's 8 MiB is distinct.
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_QUERY_SECONDS: u64 = 20;
const ENGINE_FORMAT: &str = concat!(
    "{\"Id\":{{json .Id}},\"Name\":{{json .Name}},\"Image\":{{json .Image}},",
    "\"Config\":{\"Labels\":{{json .Config.Labels}}},",
    "\"State\":{\"Running\":{{json .State.Running}},\"Pid\":{{json .State.Pid}}},",
    "\"Mounts\":{{json .Mounts}},\"HostConfig\":{",
    "\"Memory\":{{json .HostConfig.Memory}},\"MemorySwap\":{{json .HostConfig.MemorySwap}},",
    "\"PidsLimit\":{{json .HostConfig.PidsLimit}},\"NanoCpus\":{{json .HostConfig.NanoCpus}}}}"
);
const STOPPED_ENGINE_FORMAT: &str = concat!(
    "{\"Id\":{{json .Id}},\"Name\":{{json .Name}},\"Image\":{{json .Image}},",
    "\"Config\":{\"Labels\":{{json .Config.Labels}}},",
    "\"State\":{\"Running\":{{json .State.Running}},\"Pid\":{{json .State.Pid}},",
    "\"Status\":{{json .State.Status}},\"StartedAt\":{{json .State.StartedAt}},",
    "\"Paused\":{{json .State.Paused}},\"Restarting\":{{json .State.Restarting}},\"Dead\":{{json .State.Dead}}},",
    "\"Mounts\":{{json .Mounts}},\"HostConfig\":{",
    "\"Memory\":{{json .HostConfig.Memory}},\"MemorySwap\":{{json .HostConfig.MemorySwap}},",
    "\"PidsLimit\":{{json .HostConfig.PidsLimit}},\"NanoCpus\":{{json .HostConfig.NanoCpus}}}}"
);
const GPU_INFORMATION_FORMAT: &str = concat!(
    "{\"ID\":{{json .ID}},\"OSType\":{{json .OSType}},\"KernelVersion\":{{json .KernelVersion}},",
    "\"ServerVersion\":{{json .ServerVersion}},\"CDISpecDirs\":{{json .CDISpecDirs}}}"
);
const WORKER_POOL_INFORMATION_FORMAT: &str = concat!(
    "{\"ID\":{{json .ID}},\"OSType\":{{json .OSType}},",
    "\"CgroupDriver\":{{json .CgroupDriver}},\"CgroupVersion\":{{json .CgroupVersion}},",
    "\"SecurityOptions\":{{json .SecurityOptions}}}"
);

pub enum EngineQuery<'a> {
    InventoryIds,
    InspectBatch(&'a [ContainerId]),
    InspectStopped(&'a ContainerId),
    GpuInformation,
    WorkerPoolInformation,
    WorkerPoolImageInventory,
    TelemetryInventory,
    TelemetryInspect(&'a reverie_core::command_telemetry::TelemetryContainerId),
    WorkerPoolInspect(&'a ContainerId),
    WorkerImageInspect(&'a reverie_contracts::worker_image_switch::WorkerImageId),
    ProviderPane(&'a ContainerId),
    ProviderTop(&'a ContainerId),
}
impl EngineQuery<'_> {
    fn arguments(self) -> Result<Vec<OsString>> {
        let (format, ids) = match self {
            Self::WorkerPoolImageInventory => {
                return Ok(["image", "ls", "--all", "--no-trunc", "--quiet"]
                    .map(Into::into)
                    .to_vec());
            }
            Self::WorkerImageInspect(id) => {
                return Ok(["image", "inspect", "--format", "{{json .}}", id.as_str()]
                    .map(Into::into)
                    .to_vec());
            }
            Self::ProviderPane(id) => {
                return Ok([
                    "exec",
                    "--env",
                    "LANG=C.UTF-8",
                    "--env",
                    "LC_ALL=C.UTF-8",
                    id.as_str(),
                    "/bin/tmux",
                    "-u",
                    "-L",
                    "reverie-laptop",
                    "display-message",
                    "-p",
                    "-t",
                    "office",
                    "#{pane_dead}|#{pane_pid}",
                ]
                .map(Into::into)
                .to_vec());
            }
            Self::ProviderTop(id) => {
                return Ok(["top", id.as_str(), "-eo", "pid,ppid"]
                    .map(Into::into)
                    .to_vec());
            }
            Self::InventoryIds => return Ok(["ps", "-aq", "--no-trunc"].map(Into::into).to_vec()),
            Self::TelemetryInventory => {
                return Ok([
                    "ps",
                    "--all",
                    "--filter",
                    "label=reverie.worker",
                    "--format",
                    "{{.ID}}",
                ]
                .map(Into::into)
                .to_vec());
            }
            Self::TelemetryInspect(id) => {
                return Ok(["inspect", id.as_str()].map(Into::into).to_vec());
            }
            Self::WorkerPoolInspect(id) => {
                return Ok(["inspect", id.as_str()].map(Into::into).to_vec());
            }
            Self::GpuInformation => {
                return Ok(["info", "--format", GPU_INFORMATION_FORMAT]
                    .map(Into::into)
                    .to_vec());
            }
            Self::WorkerPoolInformation => {
                return Ok(["info", "--format", WORKER_POOL_INFORMATION_FORMAT]
                    .map(Into::into)
                    .to_vec());
            }
            Self::InspectBatch(ids) if !ids.is_empty() && ids.len() <= 32 => (ENGINE_FORMAT, ids),
            Self::InspectBatch(_) => return Err(EngineError::new(EngineFault::Query)),
            Self::InspectStopped(id) => (STOPPED_ENGINE_FORMAT, std::slice::from_ref(id)),
        };
        let mut args = ["inspect", "--format", format].map(Into::into).to_vec();
        args.extend(ids.iter().map(|id| OsString::from(id.as_str())));
        Ok(args)
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineFault {
    Bootstrap,
    Query,
    Busy,
    Cancelled,
    Deadline,
    Spawn,
    Identity,
    Read,
    OutputBound,
    Utf8,
    Exit,
    Finalization,
    Supervisor,
}
pub use crate::captured_client::CleanupFault;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineError {
    fault: EngineFault,
    cleanup: Vec<CleanupFault>,
    uncertain: bool,
}
impl EngineError {
    fn new(fault: EngineFault) -> Self {
        Self {
            fault,
            cleanup: Vec::new(),
            uncertain: false,
        }
    }
    pub fn fault(&self) -> EngineFault {
        self.fault
    }
    pub fn cleanup_faults(&self) -> &[CleanupFault] {
        &self.cleanup
    }
    pub fn is_uncertain(&self) -> bool {
        self.uncertain
    }
    pub fn code(&self) -> &'static str {
        if self.uncertain {
            "ENGINE_METADATA_CLIENT_UNCONFIRMED"
        } else {
            "ENGINE_METADATA_REFUSED"
        }
    }
}
impl fmt::Display for EngineError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for EngineError {}
pub type Result<T> = std::result::Result<T, EngineError>;

impl From<crate::captured_client::Error> for EngineError {
    fn from(error: crate::captured_client::Error) -> Self {
        use crate::captured_client::Fault;
        let fault = match error.fault {
            Fault::Busy => EngineFault::Busy,
            Fault::Cancelled => EngineFault::Cancelled,
            Fault::Deadline => EngineFault::Deadline,
            Fault::Spawn => EngineFault::Spawn,
            Fault::Identity => EngineFault::Identity,
            Fault::Read => EngineFault::Read,
            Fault::OutputBound => EngineFault::OutputBound,
            Fault::Utf8 => EngineFault::Utf8,
            Fault::Exit => EngineFault::Exit,
            Fault::Finalization => EngineFault::Finalization,
            Fault::Supervisor => EngineFault::Supervisor,
        };
        Self {
            fault,
            cleanup: error.cleanup,
            uncertain: error.uncertain,
        }
    }
}
