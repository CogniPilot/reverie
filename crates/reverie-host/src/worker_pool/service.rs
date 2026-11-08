//! Executable fixed controller scope. Policy, endpoint and peer remain on the
//! original stack; no Arc graph, generic command runner or serialized grant.
use super::endpoint::ControllerPeer;
use super::*;
use std::time::{Duration, Instant};
mod activation;
mod anchor;
mod member;
pub(super) mod protocol;

struct State {
    stage: InstallationStage,
    directory: Option<PoolDirectory>,
    anchor: anchor::Anchor,
    member_failure: Option<super::member::MemberComponent>,
    member_attempted: Vec<String>,
    primary: Option<PoolError>,
}
impl State {
    fn directory(&self) -> Result<&PoolDirectory> {
        self.directory
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_DIRECTORY_CLOSED"))
    }
    fn close(&mut self) -> Result<()> {
        let member = self
            .member_failure
            .as_mut()
            .map_or(Ok(()), super::member::MemberComponent::close);
        let directory = self.directory.as_mut().map_or(Ok(()), PoolDirectory::close);
        finalized(member, directory)?;
        need(
            !self.anchor.daemon_unknown,
            "WORKER_POOL_ANCHOR_EFFECT_UNCONFIRMED",
        )
    }
}
impl Drop for State {
    fn drop(&mut self) {
        std::mem::forget(self.directory.take());
    }
}
/// Constructed only by consuming an actually authenticated original broker
/// peer. Every effect still requires the App's real consent/maintenance flow.
pub struct ControllerServing<'a> {
    peer: ControllerPeer<'a>,
    policy: &'a ControllerPoolPolicy,
    state: State,
}
pub struct ControllerServingFailure<'a> {
    owner: ControllerServing<'a>,
    primary: PoolError,
}
impl<'a> ControllerServing<'a> {
    pub(super) fn new(peer: ControllerPeer<'a>, policy: &'a ControllerPoolPolicy) -> Self {
        Self {
            peer,
            policy,
            state: State {
                stage: InstallationStage::Opening,
                directory: Some(PoolDirectory::unopened(policy.data())),
                anchor: anchor::Anchor::default(),
                member_failure: None,
                member_attempted: Vec::new(),
                primary: None,
            },
        }
    }
    pub fn run(mut self) -> std::result::Result<(), Box<ControllerServingFailure<'a>>> {
        match self.requests() {
            Ok(()) => Ok(()),
            Err(primary) => Err(Box::new(ControllerServingFailure {
                owner: self,
                primary,
            })),
        }
    }
    fn requests(&mut self) -> Result<()> {
        loop {
            if !self.peer.request_ready()? {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            let received = self
                .peer
                .receive_request(Instant::now() + Duration::from_secs(2))?;
            let request = received.request;
            let mut close = false;
            let mut phase = "retained";
            let result = match &request {
                protocol::Request::Status { .. } => {
                    phase = if self.state.stage == InstallationStage::Confirmed {
                        "active"
                    } else {
                        "opening"
                    };
                    Ok(())
                }
                protocol::Request::ContinueOriginal { .. } => {
                    phase = "retained";
                    self.state
                        .member_failure
                        .as_mut()
                        .map_or(Ok(()), super::member::MemberComponent::close)
                }
                protocol::Request::Close { .. } => {
                    close = true;
                    phase = "closed";
                    self.state.close()
                }
                _ if self.state.primary.is_some() => {
                    Err(PoolError::Refused("WORKER_POOL_ORIGINAL_ATTEMPT_RETAINED"))
                }
                protocol::Request::Activate {
                    host_reserve_mi_b, ..
                } => {
                    phase = "active";
                    self.state
                        .activate(self.policy, *host_reserve_mi_b, received.end)
                }
                protocol::Request::ConfigureMember {
                    employee,
                    session,
                    container,
                    ..
                } => {
                    phase = "memberConfigured";
                    self.state.member(
                        self.policy,
                        employee,
                        session,
                        container,
                        true,
                        received.end,
                    )
                }
                protocol::Request::ObserveMember {
                    employee,
                    session,
                    container,
                    ..
                } => {
                    phase = "memberObserved";
                    self.state.member(
                        self.policy,
                        employee,
                        session,
                        container,
                        false,
                        received.end,
                    )
                }
            };
            if let Err(error) = result {
                self.state.primary.get_or_insert(error);
                phase = "retained";
            }
            let primary = self.state.primary.as_ref().or_else(|| {
                self.state
                    .member_failure
                    .as_ref()
                    .map(|owner| owner.cause())
            });
            let reply = protocol::Reply {
                version: 1,
                request_id: request.id(),
                phase,
                known: primary.is_none(),
                primary_error: primary.map(PoolError::code),
                anchor: self
                    .state
                    .anchor
                    .id
                    .as_ref()
                    .map(|id| protocol::AnchorData {
                        container: id.clone(),
                        pid: self.state.anchor.pid,
                    }),
            };
            self.peer
                .reply(&reply, Instant::now() + Duration::from_secs(2))?;
            if close {
                self.peer.close()?;
                return Ok(());
            }
        }
    }
    fn close_components(&mut self) -> Result<()> {
        let state = self.state.close();
        let peer = self.peer.close();
        finalized(state, peer)
    }
}
impl ControllerServingFailure<'_> {
    pub fn primary_error(&self) -> &PoolError {
        &self.primary
    }
    /// Original metadata/peer only. It stops no worker and never retries a
    /// Docker request, cgroup write, activation or member configuration.
    pub fn close_components(&mut self) -> Result<()> {
        self.owner.close_components()
    }
}
fn check(end: Instant) -> Result<()> {
    need(Instant::now() < end, "WORKER_POOL_ACTIVATION_DEADLINE")
}
fn hex(value: [u8; 32]) -> String {
    value.iter().map(|b| format!("{b:02x}")).collect()
}
