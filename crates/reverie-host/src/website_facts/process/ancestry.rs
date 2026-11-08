//! Bounded ancestry DATA, separate from protected kernel status and all program,
//! engine, website, current-owner and effect authorization.
use super::*;
pub struct PeerInitSnapshot {
    peer: ProcessSnapshot,
    identity: WorkerPeer,
    init: ProcessSnapshot,
}
impl PeerInitSnapshot {
    pub fn peer(&self) -> &ProcessSnapshot {
        &self.peer
    }
    pub fn peer_identity(&self) -> &WorkerPeer {
        &self.identity
    }
    pub fn init(&self) -> &ProcessSnapshot {
        &self.init
    }
}
impl WebsiteProcessObserver {
    pub fn observe_protected_peer_ancestry(
        &mut self,
        pin: &crate::worker_reports::ProtectedLaunchPeerPin,
        runtime: &crate::worker_runtime::WorkerRuntime,
        connection: &crate::worker_reports::WorkerLaunchConnection,
        metadata: &QualifiedWebsiteMetadata,
        end: Instant,
    ) -> Result<PeerInitSnapshot> {
        self.current(end)?;
        pin.assert_current(runtime, connection)?;
        let identity = *pin.peer();
        need(identity.pid() > 1, "PEER_IDENTITY")?;
        need(
            metadata
                .pid()
                .to_u64()
                .is_some_and(|pid| pid > 1 && u32::try_from(pid).is_ok()),
            "WEBSITE_INIT_SELECTION",
        )?;
        let mut files = Descriptors::default();
        let body = ancestry(&mut files, identity, metadata.pid(), end);
        let body = files.finish(body, &mut self.close_uncertain);
        finalized(
            body,
            pin.assert_current(runtime, connection)
                .map_err(WebsiteFactsError::from),
        )
    }
    /// The metadata PID remains DATA. The authenticating factory must join the
    /// same actual engine/init/program and independently protected peer status.
    pub fn observe_peer_ancestry(
        &mut self,
        channel: &mut WorkerActorChannel,
        metadata: &QualifiedWebsiteMetadata,
        end: Instant,
    ) -> Result<PeerInitSnapshot> {
        self.current(end)?;
        channel.require_connected()?;
        let identity = *channel.peer();
        need(identity.pid() > 1, "PEER_IDENTITY")?;
        need(
            metadata
                .pid()
                .to_u64()
                .is_some_and(|pid| pid > 1 && u32::try_from(pid).is_ok()),
            "WEBSITE_INIT_SELECTION",
        )?;
        let mut files = Descriptors::default();
        let body = ancestry(&mut files, identity, metadata.pid(), end);
        let body = files.finish(body, &mut self.close_uncertain);
        finalized(
            body,
            channel.require_connected().map_err(WebsiteFactsError::from),
        )
    }
}
fn ancestry(
    files: &mut Descriptors,
    identity: WorkerPeer,
    init_pid: &UnsignedInteger,
    end: Instant,
) -> Result<PeerInitSnapshot> {
    let initial = read::process(files, init_pid, end)?;
    let pid = UnsignedInteger::from_u64(identity.pid() as u64);
    let peer = read::process(files, &pid, end)?;
    need(peer.namespaces() == initial.namespaces(), "WRONG_NAMESPACE")?;
    walk(files, &peer, init_pid, end)?;
    need(
        read::process(files, &pid, end)? == peer && read::process(files, init_pid, end)? == initial,
        "PROCESS_RACE",
    )?;
    Ok(PeerInitSnapshot {
        peer,
        identity,
        init: initial,
    })
}
fn walk(
    files: &mut Descriptors,
    peer: &ProcessSnapshot,
    init: &UnsignedInteger,
    end: Instant,
) -> Result<()> {
    let mut current = peer.clone();
    // Match source range(32): the identity check precedes each parent read;
    // reaching init only on the final read does not gain a 33rd check.
    for _ in 0..32 {
        if current.pid() == init {
            return Ok(());
        }
        need(
            current.parent() > &UnsignedInteger::from_u64(1) && current.parent() != current.pid(),
            "NOT_WEBSITE_PROCESS",
        )?;
        current = read::process(files, current.parent(), end)?;
    }
    Err(WebsiteFactsError::Refused("PROCESS_DEPTH"))
}
