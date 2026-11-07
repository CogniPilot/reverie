use super::*;
use std::sync::MutexGuard;
/// A borrow of the SAME registered stream. No descriptor extraction or clone.
pub(in crate::worker_reports) struct Socket<'a> {
    service: &'a WorkerReportService,
    stream: MutexGuard<'a, Option<UnixStream>>,
}
impl<'a> Socket<'a> {
    pub(in crate::worker_reports) fn new(
        service: &'a WorkerReportService,
        stream: MutexGuard<'a, Option<UnixStream>>,
    ) -> Self {
        Self { service, stream }
    }
    pub(super) fn ready(
        &self,
        runtime: &WorkerRuntime,
        viewer: &ViewerSession,
        identity: &RelayIdentity,
        wait: TerminalWait,
    ) -> RelayResult<TerminalReady> {
        runtime
            .terminal_viewer_ready(
                viewer,
                identity,
                self.stream.as_ref().expect("held live registered socket"),
                wait,
            )
            .map_err(Into::into)
    }
    pub(super) fn receive(
        &mut self,
    ) -> Result<(reverie_core::worker_wire::WorkerFrameHeader, Vec<u8>)> {
        wire::receive(
            self.service,
            self.stream.as_mut().expect("held live registered socket"),
        )
    }
    pub(super) fn output(&mut self, bytes: &[u8]) -> Result<()> {
        self.send(b'O', bytes)
    }
    pub(super) fn exit(&mut self, bytes: &[u8]) -> Result<()> {
        self.send(b'X', bytes)
    }
    pub(in crate::worker_reports) fn error(&mut self, message: &str) -> Result<()> {
        self.send(b'E', &message.as_bytes()[..message.len().min(1000)])
    }
    fn send(&mut self, kind: u8, bytes: &[u8]) -> Result<()> {
        wire::send(
            self.service,
            self.stream.as_mut().expect("held live registered socket"),
            kind,
            bytes,
        )
    }
}
