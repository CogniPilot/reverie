use super::InstallingBroker;
use reverie_host::worker_reports::WorkerReportError;
use std::{os::unix::net::UnixStream, time::Instant};

/// T-handler/collector settlement only, never a laptop/storage/global release ACK.
#[derive(Debug)]
pub struct TelemetryCloseError {
    transport: Option<WorkerReportError>,
    store_pending: bool,
}
impl TelemetryCloseError {
    pub fn transport_error(&self) -> Option<&WorkerReportError> {
        self.transport.as_ref()
    }
    pub fn store_pending(&self) -> bool {
        self.store_pending
    }
}
impl std::fmt::Display for TelemetryCloseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WORKER_TELEMETRY_CLOSE_UNCONFIRMED")
    }
}
impl std::error::Error for TelemetryCloseError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.transport.as_ref().map(|error| error as _)
    }
}
impl InstallingBroker {
    /// Fixed protected T operation on an actual accepted connection. Kernel UID
    /// is checked before frames/collector access. The listener/common dispatcher
    /// remains a separate integration obligation; no owner authority is minted.
    pub fn handle_command_failure_report(
        &self,
        connection: UnixStream,
    ) -> Result<(), WorkerReportError> {
        self.reports.handle(connection, self.command_telemetry())
    }
    /// Publish the actual first stop, close all T handlers under that same
    /// deadline, and independently inspect retained SQLite owners. This does
    /// not seal the shared engine, join caller-owned dispatcher threads, or
    /// replace the broker's remaining cleanup.
    pub fn close_command_telemetry(&self, deadline: Instant) -> Result<(), TelemetryCloseError> {
        let end = deadline.min(self.storage.runtime.request_stop());
        let transport = self.reports.close(end).err();
        let store_pending = self.command_telemetry().has_pending_store();
        if transport.is_some() || store_pending {
            return Err(TelemetryCloseError {
                transport,
                store_pending,
            });
        }
        Ok(())
    }
}
