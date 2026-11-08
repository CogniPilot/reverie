//! Read-only process snapshots, never website, program or owner authority.
mod ancestry;
mod read;
pub use ancestry::PeerInitSnapshot;
#[cfg(test)]
pub(crate) mod tests;
use super::{
    Result, WebsiteFactsError,
    files::{Descriptors, finalized},
    need,
};
use crate::worker_reports::{WorkerActorChannel, WorkerPeer};
use reverie_contracts::resource_actor::QualifiedWebsiteMetadata;
use reverie_core::{decimal::UnsignedInteger, operations::JournalDigest};
use std::time::Instant;

#[derive(Clone, Debug, Eq, PartialEq)]
/// Kernel observation DATA, not a program/website/owner or action grant.
pub struct ProcessSnapshot {
    pid: UnsignedInteger,
    start: UnsignedInteger,
    parent: UnsignedInteger,
    argv: JournalDigest,
    executable: [u64; 2],
    namespaces: [u64; 3],
}
impl ProcessSnapshot {
    pub fn pid(&self) -> &UnsignedInteger {
        &self.pid
    }
    pub fn start(&self) -> &UnsignedInteger {
        &self.start
    }
    pub fn parent(&self) -> &UnsignedInteger {
        &self.parent
    }
    pub fn argv_digest(&self) -> &JournalDigest {
        &self.argv
    }
    pub fn executable(&self) -> [u64; 2] {
        self.executable
    }
    pub fn namespaces(&self) -> [u64; 3] {
        self.namespaces
    }
}
pub struct PeerProcessSnapshot {
    process: ProcessSnapshot,
    peer: WorkerPeer,
}
impl PeerProcessSnapshot {
    pub fn process(&self) -> &ProcessSnapshot {
        &self.process
    }
    pub fn peer(&self) -> &WorkerPeer {
        &self.peer
    }
}
#[derive(Default)]
#[must_use = "retain this observer and the original channel hold on uncertain descriptor close"]
pub struct WebsiteProcessObserver {
    close_uncertain: bool,
}
impl WebsiteProcessObserver {
    /// Purpose-private bootstrap SELF observation, never a caller-selected PID.
    pub(crate) fn observe_current_broker(&mut self, end: Instant) -> Result<ProcessSnapshot> {
        self.current(end)?;
        let pid = UnsignedInteger::from_u64(u64::from(std::process::id()));
        let mut files = Descriptors::default();
        let body = read::process(&mut files, &pid, end);
        files.finish(body, &mut self.close_uncertain)
    }
    pub fn assert_finalized(&self) -> Result<()> {
        need(!self.close_uncertain, "WEBSITE_PROCESS_CLOSE_UNCONFIRMED")
    }
    /// Only a PID declared by previously compared metadata DATA. The factory
    /// must independently bracket its actual engine/init incarnation.
    pub fn observe_init(
        &mut self,
        metadata: &QualifiedWebsiteMetadata,
        end: Instant,
    ) -> Result<ProcessSnapshot> {
        self.current(end)?;
        let pid = metadata.pid();
        need(
            pid.to_u64()
                .is_some_and(|pid| pid > 1 && u32::try_from(pid).is_ok()),
            "WEBSITE_INIT_SELECTION",
        )?;
        let mut files = Descriptors::default();
        let body = read::process(&mut files, pid, end);
        files.finish(body, &mut self.close_uncertain)
    }
    /// Takes the actual exclusive channel, never a caller-supplied PID. The
    /// original kernel credentials and pinned peer are checked around all I/O.
    pub fn observe_peer(
        &mut self,
        channel: &mut WorkerActorChannel,
        end: Instant,
    ) -> Result<PeerProcessSnapshot> {
        self.current(end)?;
        channel.require_connected()?;
        let peer = *channel.peer();
        need(peer.pid() > 1, "PEER_IDENTITY")?;
        let pid = UnsignedInteger::from_u64(peer.pid() as u64);
        let mut files = Descriptors::default();
        let body = self.peer_body(&mut files, &pid, peer, end);
        let body = files.finish(body, &mut self.close_uncertain);
        let checked = channel.require_connected().map_err(WebsiteFactsError::from);
        finalized(body, checked)
    }
    fn peer_body(
        &self,
        files: &mut Descriptors,
        pid: &UnsignedInteger,
        peer: WorkerPeer,
        end: Instant,
    ) -> Result<PeerProcessSnapshot> {
        let process = read::process(files, pid, end)?;
        read::status(files, pid, end)?;
        need(
            read::process(files, pid, end)? == process,
            "BACKEND_STATUS_RACE",
        )?;
        Ok(PeerProcessSnapshot { process, peer })
    }
    fn current(&self, end: Instant) -> Result<()> {
        need(!self.close_uncertain, "WEBSITE_PROCESS_CLOSE_UNCONFIRMED")?;
        need(Instant::now() < end, "PROCESS_DEADLINE")
    }
}
