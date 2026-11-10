//! Executable fixed controller scope. Policy, endpoint and peer remain on the
//! original stack; no Arc graph, generic command runner or serialized grant.
use super::endpoint::ControllerPeer;
use super::*;
use std::time::{Duration, Instant};
mod activation;
mod anchor;
mod member;
mod member_policy;
pub(super) mod protocol;

struct State {
    stage: InstallationStage,
    directory: Option<PoolDirectory>,
    anchor: anchor::Anchor,
    member_failure: Option<super::member::MemberComponent>,
    member_attempted: Vec<String>,
    member_policies: super::member_policy::MemberPolicies,
    member_policy_revision: u64,
    restored_birth: Option<protocol::RestoredBirthAck>,
    edit: Option<member_policy::EditAttempt>,
    primary: Option<PoolError>,
}
impl State {
    fn continue_original(&mut self) -> Result<()> {
        let member = self
            .member_failure
            .as_mut()
            .map_or(Ok(()), super::member::MemberComponent::close);
        let edit = self
            .edit
            .as_mut()
            .map_or(Ok(()), member_policy::EditAttempt::close_components);
        finalized(member, edit)?;
        need(self.edit.is_none(), "WORKER_POOL_MEMBER_EDIT_RETAINED")
    }
    fn phase(&self) -> &'static str {
        if self.edit.is_some() {
            "memberPolicyRetained"
        } else if self.stage == InstallationStage::Confirmed {
            "active"
        } else {
            "opening"
        }
    }
    fn primary_error(&self) -> Option<&PoolError> {
        self.primary
            .as_ref()
            .or_else(|| self.member_failure.as_ref().map(|owner| owner.cause()))
    }
    fn directory(&self) -> Result<&PoolDirectory> {
        self.directory
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_DIRECTORY_CLOSED"))
    }
    fn close(&mut self) -> Result<()> {
        let member = self.continue_original();
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
        std::mem::forget((
            self.directory.take(),
            std::mem::take(&mut self.anchor),
            self.member_failure.take(),
            std::mem::take(&mut self.member_attempted),
            std::mem::take(&mut self.member_policies),
            self.edit.take(),
            self.primary.take(),
        ));
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
        let birth = policy.service_birth();
        let (member_policies, member_policy_revision) =
            super::member_policy::MemberPolicies::from_birth(birth);
        let restored_birth = birth.and_then(|birth| {
            protocol::RestoredBirthAck::from_birth(birth, policy.version_digest_data())
        });
        Self {
            peer,
            policy,
            state: State {
                stage: InstallationStage::Opening,
                directory: Some(PoolDirectory::unopened(policy.data())),
                anchor: anchor::Anchor::default(),
                member_failure: None,
                member_attempted: Vec::new(),
                member_policies,
                member_policy_revision,
                restored_birth,
                edit: None,
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
            if self.handle_member_policy_request(&request, received.end)? {
                continue;
            }
            let mut close = false;
            let mut phase = "retained";
            let result = match &request {
                protocol::Request::Status { .. } => {
                    phase = self.state.phase();
                    Ok(())
                }
                protocol::Request::ContinueOriginal { .. } => {
                    phase = "retained";
                    self.state.continue_original()
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
                protocol::Request::Resume {
                    host_reserve_mi_b, ..
                } => {
                    phase = "active";
                    self.state
                        .resume(self.policy, *host_reserve_mi_b, received.end)
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
                protocol::Request::ApplyMemberPolicy { .. }
                | protocol::Request::CommitMemberPolicy { .. } => {
                    unreachable!("employee policy replies are handled separately")
                }
            };
            if let Err(error) = result {
                self.state.primary.get_or_insert(error);
                phase = "retained";
            }
            let primary = self.state.primary_error();
            Self::reply(
                &mut self.peer,
                &self.state,
                &request,
                phase,
                primary.is_none(),
                primary,
            )?;
            if close {
                return self.close_reply();
            }
        }
    }
    fn handle_member_policy_request(
        &mut self,
        request: &protocol::Request,
        end: Instant,
    ) -> Result<bool> {
        let reply = match request {
            protocol::Request::ApplyMemberPolicy { edit, .. } => {
                self.state
                    .apply_member_policy(self.policy, &mut self.peer, edit, end)
            }
            protocol::Request::CommitMemberPolicy { operation, .. } => self
                .state
                .commit_member_policy(self.policy, &mut self.peer, operation, end),
            protocol::Request::Activate { .. }
            | protocol::Request::Resume { .. }
            | protocol::Request::ConfigureMember { .. }
            | protocol::Request::ObserveMember { .. }
                if self.state.edit.is_some() =>
            {
                member_policy::EditReply::Retained
            }
            _ => return Ok(false),
        };
        let error = match &reply {
            member_policy::EditReply::Refused(error) => Some(error),
            member_policy::EditReply::Retained => self
                .state
                .edit
                .as_ref()
                .and_then(member_policy::EditAttempt::failure),
            _ => None,
        };
        Self::reply(
            &mut self.peer,
            &self.state,
            request,
            reply.phase(),
            reply.known(),
            error,
        )?;
        Ok(true)
    }
    fn reply(
        peer: &mut ControllerPeer<'_>,
        state: &State,
        request: &protocol::Request,
        phase: &'static str,
        known: bool,
        primary: Option<&PoolError>,
    ) -> Result<()> {
        let capability = matches!(
            request,
            protocol::Request::Status { .. }
                | protocol::Request::Activate { .. }
                | protocol::Request::Resume { .. }
        )
        .then_some(protocol::MEMBER_POLICY_EDIT_VERSION);
        peer.reply(
            &protocol::Reply {
                version: 1,
                request_id: request.id(),
                phase,
                known,
                primary_error: primary.map(PoolError::code),
                anchor: state.anchor.id.as_ref().map(|id| protocol::AnchorData {
                    container: id.clone(),
                    pid: state.anchor.pid,
                }),
                member_policy_edit_version: capability,
                restored_birth: capability.and_then(|_| state.restored_birth.clone()),
            },
            Instant::now() + Duration::from_secs(2),
        )
    }
    fn close_reply(&mut self) -> Result<()> {
        let peer = self.peer.close();
        if self.state.primary.is_some() {
            return finalized(
                Err(PoolError::Refused("WORKER_POOL_ORIGINAL_ATTEMPT_RETAINED")),
                peer,
            );
        }
        peer
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
pub(super) fn check(end: Instant) -> Result<()> {
    need(Instant::now() < end, "WORKER_POOL_ACTIVATION_DEADLINE")
}
fn hex(value: [u8; 32]) -> String {
    value.iter().map(|b| format!("{b:02x}")).collect()
}
