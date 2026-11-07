//! Purpose-private relay operations retain the real laptop record throughout
//! every borrowed descriptor/native operation; no CID/path/FD escapes publicly.
use super::*;
use crate::worker_reports::terminal::{
    RelayIdentity, RelayTarget, TerminalObservation, TerminalReady, TerminalWait,
};
use reverie_contracts::worker_launch::ViewerClient;
use reverie_core::{ids::ProfileSessionId, posix_path::PosixPath};
use std::os::unix::net::UnixStream;
impl WorkerRuntime {
    pub(crate) fn bind_terminal_viewer(
        &self,
        viewer: &ViewerSession,
        identity: &RelayIdentity,
        session: &ProfileSessionId,
    ) -> Result<()> {
        let record = self.laptop_workflows().viewer(self, viewer, true)?;
        let target = match &record {
            ViewerGuard::Created(record) => created_target(record)?,
            ViewerGuard::Existing(record) => record.terminal_target(self)?,
        };
        need(
            &target.session == session,
            "VIEWER_CONNECTION_SESSION_CHANGED",
        )?;
        viewer.job.bind_transport(identity, target)
    }
    pub(crate) fn terminal_viewer_ready(
        &self,
        viewer: &ViewerSession,
        identity: &RelayIdentity,
        stream: &UnixStream,
        wait: TerminalWait,
    ) -> Result<TerminalReady> {
        let _record = self.laptop_workflows().viewer(self, viewer, true)?;
        viewer.job.terminal_ready(identity, stream, wait)
    }
    pub(crate) fn terminal_resize_viewer(
        &self,
        viewer: &ViewerSession,
        identity: &RelayIdentity,
        size: TerminalSize,
    ) -> Result<()> {
        let _record = self.laptop_workflows().viewer(self, viewer, true)?;
        viewer.job.terminal_resize(identity, size)
    }
    pub(crate) fn terminal_signal_viewer(
        &self,
        viewer: &ViewerSession,
        identity: &RelayIdentity,
    ) -> Result<()> {
        let _record = self.laptop_workflows().viewer(self, viewer, true)?;
        viewer.job.terminal_signal(identity)
    }
    pub(crate) fn terminal_viewer_receipt(
        &self,
        viewer: &ViewerSession,
        identity: &RelayIdentity,
    ) -> Result<Option<Vec<u8>>> {
        let _record = self.laptop_workflows().viewer(self, viewer, true)?;
        viewer.job.terminal_receipt(identity)
    }
    pub(crate) fn terminal_viewer_has_receipt(
        &self,
        viewer: &ViewerSession,
        identity: &RelayIdentity,
    ) -> Result<bool> {
        let _record = self.laptop_workflows().viewer(self, viewer, true)?;
        viewer.job.terminal_has_receipt(identity)
    }
    pub(crate) fn terminal_viewer_clients(
        &self,
        viewer: &ViewerSession,
        identity: &RelayIdentity,
        end: Instant,
    ) -> Result<TerminalObservation> {
        self.terminal_query(viewer, identity, job::Query::Clients, end)
    }
    pub(crate) fn terminal_viewer_environment(
        &self,
        viewer: &ViewerSession,
        identity: &RelayIdentity,
        client: ViewerClient,
        end: Instant,
    ) -> Result<TerminalObservation> {
        self.terminal_query(viewer, identity, job::Query::Environment(client), end)
    }
    pub(crate) fn terminal_viewer_pane(
        &self,
        viewer: &ViewerSession,
        identity: &RelayIdentity,
        end: Instant,
    ) -> Result<TerminalObservation> {
        self.terminal_query(viewer, identity, job::Query::PaneDead, end)
    }
    fn terminal_query(
        &self,
        viewer: &ViewerSession,
        identity: &RelayIdentity,
        query: job::Query,
        end: Instant,
    ) -> Result<TerminalObservation> {
        let _record = self.laptop_workflows().viewer(self, viewer, true)?;
        Ok(match viewer.job.terminal_query(identity, query, end)? {
            job::QueryObservation::Value(value) => TerminalObservation::Value(value),
            job::QueryObservation::Missed => TerminalObservation::Missed,
            job::QueryObservation::Unavailable => TerminalObservation::Unavailable,
            job::QueryObservation::CleanupUnconfirmed => TerminalObservation::CleanupUnconfirmed,
        })
    }
    pub(crate) fn terminal_viewer_marker(&self, viewer: &ViewerSession) -> Result<String> {
        let _record = self.laptop_workflows().viewer(self, viewer, true)?;
        Ok(viewer.job.terminal_marker())
    }
    /// This settles only the actual viewer's fixed query, without reaping or
    /// signalling the viewer group or consuming its original storage owner.
    pub fn settle_laptop_viewer_queries(&self, viewer: &ViewerSession, end: Instant) -> Result<()> {
        let _record = self.laptop_workflows().viewer(self, viewer, false)?;
        viewer.job.settle_terminal_queries(end)
    }
}
fn created_target(record: &Record) -> Result<RelayTarget> {
    let resources = record.resources();
    let creation = record
        .creation
        .as_ref()
        .ok_or(LaptopError::Refused("VIEWER_CREATED_RECORD_REQUIRED"))?;
    let publication = creation
        .publication
        .as_ref()
        .ok_or(LaptopError::Refused("VIEWER_PUBLICATION_REQUIRED"))?;
    need(publication.confirmed(), "VIEWER_PUBLICATION_UNCONFIRMED")?;
    let home = PosixPath::try_new(&crate::native::python_text(
        resources.storage().paths().home(),
    ))
    .map_err(|_| LaptopError::Refused("VIEWER_COMPLETION_PATH"))?;
    let exit = home
        .join(&PosixPath::from_scalar_text(".reverie-launch"))
        .join(&PosixPath::from_scalar_text(&format!(
            "{}.exit",
            publication.nonce().as_str()
        )));
    Ok(RelayTarget {
        session: resources.plan.session().clone(),
        exit,
        container: creation.container.clone(),
    })
}
