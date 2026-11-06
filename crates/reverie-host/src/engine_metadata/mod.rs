//! Fixed read-only engine queries over one service-owned supervised client.
//! Bootstrap, rows and diagnostics are protected data, never wire-selected
//! commands, owner authorization, engine identity or mutation permission.
mod bootstrap;
mod control;
#[cfg(test)]
mod installed_context_tests;
#[cfg(test)]
pub(crate) mod tests;
pub use bootstrap::EngineBootstrap;
pub use control::{CancellationToken, ReadonlyEngine};
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

pub enum EngineQuery<'a> {
    InventoryIds,
    InspectBatch(&'a [ContainerId]),
    InspectStopped(&'a ContainerId),
    TelemetryInventory,
    TelemetryInspect(&'a reverie_core::command_telemetry::TelemetryContainerId),
}
impl EngineQuery<'_> {
    fn arguments(self) -> Result<Vec<OsString>> {
        let (format, ids) = match self {
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
