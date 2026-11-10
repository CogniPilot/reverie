//! Compile-bound inventory and actual guest-root code observations. These
//! readers grant no launch, pool membership, admission or resource release.
mod files;
mod init;
use crate::{ObservationError, native, worker_runtime::WorkerRuntime};
use reverie_contracts::task_perf_capsule::{
    MAX_INVENTORY_BYTES, PerfCapsuleDataError, PerfCapsuleInventory,
};
use std::{fmt, path::Path, time::Instant};

const MANIFEST: Option<&str> = option_env!("REVERIE_FIXED_PERF_GUEST_CAPSULE_MANIFEST");
pub(crate) fn manifest_reference() -> Option<&'static str> {
    MANIFEST
}

#[derive(Debug)]
pub(crate) enum CapsuleError {
    Refused(&'static str),
    Data(PerfCapsuleDataError),
    Observation(ObservationError),
    Io(std::io::Error),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl CapsuleError {
    pub(crate) fn unconfirmed_native(&self) -> bool {
        match self {
            Self::Observation(_) => true,
            Self::Finalization { primary, secondary } => {
                primary.unconfirmed_native() || secondary.unconfirmed_native()
            }
            _ => false,
        }
    }
}
impl fmt::Display for CapsuleError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(code) => out.write_str(code),
            Self::Data(error) => error.fmt(out),
            Self::Observation(error) => error.fmt(out),
            Self::Io(error) => error.fmt(out),
            Self::Finalization { primary, secondary } => {
                write!(out, "{primary}; close: {secondary}")
            }
        }
    }
}
impl std::error::Error for CapsuleError {}
impl From<ObservationError> for CapsuleError {
    fn from(error: ObservationError) -> Self {
        Self::Observation(error)
    }
}
impl From<std::io::Error> for CapsuleError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
type Result<T> = std::result::Result<T, CapsuleError>;
fn need(condition: bool, code: &'static str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(CapsuleError::Refused(code))
    }
}
fn check(runtime: &WorkerRuntime, end: Instant) -> Result<()> {
    let end = runtime.stop_deadline().map_or(end, |stop| end.min(stop));
    need(
        !runtime.cancellation().is_cancelled() && Instant::now() < end,
        "TASK_PERF_CAPSULE_DEADLINE",
    )
}
fn finalized<T>(body: Result<T>, close: Result<()>) -> Result<T> {
    match (body, close) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(CapsuleError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
pub(crate) struct InstalledCapsule {
    inventory: PerfCapsuleInventory,
}
impl InstalledCapsule {
    pub(crate) fn observe(runtime: &WorkerRuntime, end: Instant) -> Result<Self> {
        check(runtime, end)?;
        let path = MANIFEST.ok_or(CapsuleError::Refused("TASK_PERF_CAPSULE_UNCONFIGURED"))?;
        let path = native::canonical_in(Path::new(path), Path::new("/nix/store"))?;
        let bytes = native::observe(&path, MAX_INVENTORY_BYTES, super::allowed_metadata)?;
        let inventory = PerfCapsuleInventory::decode(&bytes).map_err(CapsuleError::Data)?;
        check(runtime, end)?;
        Ok(Self { inventory })
    }
    pub(crate) fn into_guest(self) -> GuestFiles {
        GuestFiles {
            inventory: self.inventory,
            root: files::Root::unopened(),
            opened: false,
            close_unknown: false,
            closed: false,
        }
    }
}
/// Stored in the actual Creation record BEFORE the first guest-root open.
pub(crate) struct GuestFiles {
    inventory: PerfCapsuleInventory,
    root: files::Root,
    opened: bool,
    close_unknown: bool,
    closed: bool,
}
impl GuestFiles {
    pub(crate) fn open(&mut self, runtime: &WorkerRuntime, pid: u32, end: Instant) -> Result<()> {
        need(!self.opened && !self.closed, "TASK_PERF_CAPSULE_REPLAYED")?;
        self.opened = true;
        self.root.open(runtime, pid, end)?;
        self.reobserve(runtime, pid, end)
    }
    pub(crate) fn reobserve(&self, runtime: &WorkerRuntime, pid: u32, end: Instant) -> Result<()> {
        need(
            self.opened && !self.closed && !self.close_unknown,
            "TASK_PERF_CAPSULE_CLOSED",
        )?;
        self.root.current(pid)?;
        self.root.observe(runtime, &self.inventory, end)?;
        self.root.init_executable(
            runtime,
            pid,
            self.inventory
                .code_files()
                .get("bin/reverie-worker-init")
                .expect("v2 inventory requires the sealed init")
                .as_str(),
            end,
        )?;
        self.root.current(pid)
    }
    pub(crate) fn close(&mut self) -> Result<()> {
        if !self.closed {
            self.closed = true;
            let close = self.root.close();
            self.close_unknown |= close.is_err();
            close?;
        }
        need(!self.close_unknown, "TASK_PERF_CAPSULE_CLOSE_UNKNOWN")
    }
}
