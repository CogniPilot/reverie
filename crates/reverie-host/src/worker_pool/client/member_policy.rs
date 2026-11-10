use super::*;
use crate::{
    reservation_control::{AdmissionLock, ControlHostError, MemberPolicyPending},
    website_facts::WebsiteProcessObserver,
    worker_pool::service::protocol::{MEMBER_POLICY_EDIT_VERSION, MemberPolicyEdit},
    worker_runtime::WorkerStopBudget,
};
use reverie_contracts::{
    storage_identity::CurrentEmployee,
    worker_config::{EffectiveWorkerConfig, WorkerConfigDigest, config_digest},
    worker_pool::{WorkerPoolMemberPolicy, WorkerPoolProvider},
};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    operations::JournalId,
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
pub(super) struct EditState {
    identity: Arc<()>,
    supported: bool,
    policies: crate::worker_pool::member_policy::MemberPolicies,
    revision: u64,
    pub(super) attempt: Option<Attempt>,
}

impl EditState {
    pub(super) fn from_birth(
        birth: &reverie_contracts::worker_pool::ControllerServiceBirth,
    ) -> Self {
        let (policies, revision) =
            crate::worker_pool::member_policy::MemberPolicies::from_birth(Some(birth));
        Self {
            policies,
            revision,
            ..Self::default()
        }
    }

    pub(super) fn negotiate(&mut self, reply: &serde_json::Value) {
        self.supported = reply
            .get("memberPolicyEditVersion")
            .is_some_and(|version| *version == MEMBER_POLICY_EDIT_VERSION);
    }

    fn matches(&self, birth: &WorkerPoolPolicy, provider: &WorkerPoolProvider) -> bool {
        provider.policy() == birth
            && provider.member_revision() == self.revision
            && provider.member_overrides() == self.policies.overrides()
    }

    pub(super) fn effective(
        &self,
        birth: &WorkerPoolPolicy,
        employee: &str,
    ) -> Result<WorkerPoolMemberPolicy> {
        self.policies.effective(birth, employee)
    }
}

/// Produced only by the actual controller and current selected worker observation.
/// The application still owns consent and the durable intent before issuing it.
#[must_use]
pub struct PreparedMemberPolicyEdit {
    controller: Arc<()>,
    identity: Arc<()>,
    dispatch_claimed: AtomicBool,
    employee: ProfileEmployeeId,
    session: ProfileSessionId,
    container: ContainerId,
    operation: JournalId,
    source_digest: WorkerConfigDigest,
    request: MemberPolicyEdit,
    end: Instant,
    stop: WorkerStopBudget,
}

pub struct MemberPolicyEditSelection<'a> {
    pub current: &'a CurrentEmployee,
    pub container: &'a ContainerId,
    pub configuration: &'a EffectiveWorkerConfig,
    pub proposed: WorkerPoolMemberPolicy,
    pub operation: &'a JournalId,
}

impl PreparedMemberPolicyEdit {
    pub(crate) fn identity(&self) -> &Arc<()> {
        &self.identity
    }
    /// Issue and checked cancellation compete for this same one-way claim.
    pub(crate) fn claim_unissued(&self) -> bool {
        !self.dispatch_claimed.swap(true, Ordering::AcqRel)
    }
    pub(crate) fn source_digest(&self) -> &WorkerConfigDigest {
        &self.source_digest
    }
    pub fn employee(&self) -> &ProfileEmployeeId {
        &self.employee
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn container(&self) -> &ContainerId {
        &self.container
    }
    pub fn pid(&self) -> u32 {
        self.request.pid
    }
    pub fn process_start(&self) -> &str {
        &self.request.start
    }
    pub fn leaf_identity(&self) -> (u64, u64) {
        self.request.leaf
    }
    pub fn before(&self) -> WorkerPoolMemberPolicy {
        self.request.before
    }
    pub fn proposed(&self) -> WorkerPoolMemberPolicy {
        self.request.proposed
    }
    pub fn expected_revision(&self) -> u64 {
        self.request.expected_revision
    }
    pub fn operation(&self) -> &JournalId {
        &self.operation
    }
    pub fn deadline(&self) -> Instant {
        self.stop_budget()
            .deadline()
            .map_or(self.end, |end| self.end.min(end))
    }
    pub(crate) fn stop_budget(&self) -> &WorkerStopBudget {
        &self.stop
    }
}

/// The same controller verified both configured values on the original member.
/// File and in-memory publication remain the owning application's responsibility.
#[must_use]
pub struct MemberPolicyEditVerified {
    prepared: Arc<()>,
}
impl MemberPolicyEditVerified {
    pub fn assert_prepared(&self, prepared: &PreparedMemberPolicyEdit) -> Result<()> {
        assert_prepared(&self.prepared, prepared)
    }
}

/// The original controller has committed the already-published policy.
#[must_use]
pub struct MemberPolicyEditCommitted {
    prepared: Arc<()>,
}
impl MemberPolicyEditCommitted {
    pub fn assert_prepared(&self, prepared: &PreparedMemberPolicyEdit) -> Result<()> {
        assert_prepared(&self.prepared, prepared)
    }
}
/// The exact controller received the original edit and refused before writing
/// either selected field. This does not release the application's file fence.
#[derive(Debug)]
#[must_use]
pub struct MemberPolicyEditRejected {
    prepared: Arc<()>,
}
impl MemberPolicyEditRejected {
    pub fn assert_prepared(&self, prepared: &PreparedMemberPolicyEdit) -> Result<()> {
        assert_prepared(&self.prepared, prepared)
    }
}

fn assert_prepared(identity: &Arc<()>, prepared: &PreparedMemberPolicyEdit) -> Result<()> {
    need(
        Arc::ptr_eq(identity, &prepared.identity),
        "WORKER_POOL_MEMBER_EDIT_OWNER",
    )
}

#[must_use]
pub enum MemberPolicyEditSettlement {
    Verified(MemberPolicyEditVerified),
    Committed(MemberPolicyEditCommitted),
}

#[derive(Debug)]
pub enum MemberPolicyEditError {
    Refused(PoolError),
    Rejected(MemberPolicyEditRejected),
    BeforeEffect(ControlHostError),
    RetainedIntent(ControlHostError),
    Retained,
}

impl MemberPolicyEditError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(error) => error.code(),
            Self::Rejected(_) => "WORKER_POOL_MEMBER_EDIT_REFUSED",
            Self::BeforeEffect(error) | Self::RetainedIntent(error) => error.code(),
            Self::Retained => "WORKER_POOL_MEMBER_EDIT_RETAINED",
        }
    }
    pub fn is_retained(&self) -> bool {
        matches!(self, Self::Retained | Self::RetainedIntent(_))
    }
}

impl std::fmt::Display for MemberPolicyEditError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for MemberPolicyEditError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(error) => Some(error),
            Self::BeforeEffect(error) | Self::RetainedIntent(error) => Some(error),
            Self::Rejected(_) | Self::Retained => None,
        }
    }
}

type EditResult<T> = std::result::Result<T, MemberPolicyEditError>;

pub(super) struct Attempt {
    prepared: Arc<()>,
    request: MemberPolicyEdit,
    end: Instant,
    phase: Phase,
    first_cause: Option<PoolError>,
}

enum Phase {
    Applying(io::MemberPolicyWire),
    Verified,
    Committing(io::MemberPolicyWire),
}

impl ActivatedController {
    pub fn member_policy_edit_supported(&self) -> bool {
        self.state().member_policy_edit.supported
    }

    pub fn assert_member_policy_provider(&self, provider: &WorkerPoolProvider) -> Result<()> {
        let state = self.state();
        need(
            state.member_policy_edit.matches(&state.policy, provider),
            "WORKER_POOL_MEMBER_EDIT_REVISION",
        )
    }

    pub(crate) fn effective_member_policy(&self, employee: &str) -> Result<WorkerPoolMemberPolicy> {
        let state = self.state();
        state.member_policy_edit.effective(&state.policy, employee)
    }

    pub(crate) fn assert_member_policy_unfenced(&self) -> Result<()> {
        self.state().require_no_member_policy_edit()
    }

    pub fn member_policy_edit_failure(&self) -> Option<&PoolError> {
        self.state()
            .member_policy_edit
            .attempt
            .as_ref()?
            .first_cause
            .as_ref()
    }

    pub fn prepare_member_policy_edit(
        &mut self,
        runtime: &WorkerRuntime,
        query: &MetadataQueryOwner,
        processes: &mut WebsiteProcessObserver,
        selection: MemberPolicyEditSelection<'_>,
        end: Instant,
    ) -> Result<PreparedMemberPolicyEdit> {
        let MemberPolicyEditSelection {
            current,
            container,
            configuration,
            proposed,
            operation,
        } = selection;
        need(
            self.member_policy_edit_supported(),
            "WORKER_POOL_MEMBER_EDIT_UNSUPPORTED",
        )?;
        let provider = WorkerPoolProvider::from_config(configuration)
            .map_err(|_| PoolError::Refused("WORKER_POOL_PROVIDER_INVALID"))?
            .ok_or(PoolError::Refused("WORKER_POOL_MEMBER_EDIT_PROVIDER"))?;
        self.assert_member_policy_provider(&provider)?;
        let employee = current.identity().as_str();
        let before = self.effective_member_policy(employee)?;
        let birth = crate::worker_pool::member_policy::birth_policy(self.policy_data(), employee)?;
        need(
            before != proposed
                && (proposed == birth
                    || proposed.memory_high_mib() < self.policy_data().memory_max_mi_b)
                && provider.member_revision().checked_add(1).is_some(),
            "WORKER_POOL_MEMBER_EDIT_POLICY",
        )?;
        let end = runtime.stop_deadline().map_or(end, |stop| stop.min(end));
        let observed =
            self.observe_employee_resources(runtime, query, processes, current, container, end)?;
        need(
            observed.memory_high_bytes == before.memory_high_bytes().to_string()
                && observed.cpu_weight == before.cpu_weight(),
            "WORKER_POOL_MEMBER_EDIT_READBACK",
        )?;
        let parse_identity = |value: &str| {
            value
                .parse::<u64>()
                .map_err(|_| PoolError::Refused("WORKER_POOL_MEMBER_EDIT_IDENTITY"))
        };
        Ok(PreparedMemberPolicyEdit {
            controller: Arc::clone(&self.state().member_policy_edit.identity),
            identity: Arc::new(()),
            dispatch_claimed: AtomicBool::new(false),
            employee: current.identity().clone(),
            session: current.session().clone(),
            container: container.clone(),
            operation: operation.clone(),
            source_digest: config_digest(configuration),
            request: MemberPolicyEdit {
                operation: operation.as_str().to_owned(),
                employee: employee.to_owned(),
                session: current.session().as_str().to_owned(),
                container: container.as_str().to_owned(),
                pid: observed.pid,
                start: observed.process_start,
                leaf: (
                    parse_identity(&observed.leaf_device)?,
                    parse_identity(&observed.leaf_inode)?,
                ),
                before,
                proposed,
                expected_revision: provider.member_revision(),
            },
            end,
            stop: self.state().binding.stop.clone(),
        })
    }

    pub fn issue_member_policy_edit(
        &mut self,
        prepared: &PreparedMemberPolicyEdit,
        pending: &MemberPolicyPending,
        admission: &AdmissionLock,
    ) -> EditResult<MemberPolicyEditVerified> {
        let state = self.state_mut();
        state
            .require_active()
            .map_err(MemberPolicyEditError::Refused)?;
        let end = state
            .edit_effect_end(prepared.deadline())
            .map_err(MemberPolicyEditError::Refused)?;
        need(
            Arc::ptr_eq(&prepared.controller, &state.member_policy_edit.identity)
                && prepared.request.expected_revision == state.member_policy_edit.revision,
            "WORKER_POOL_MEMBER_EDIT_OWNER",
        )
        .map_err(MemberPolicyEditError::Refused)?;
        let request_id = fresh_id().map_err(MemberPolicyEditError::Refused)?;
        let command = serde_json::json!({
            "verb": "applyMemberPolicy", "requestId": request_id,
            "version": MEMBER_POLICY_EDIT_VERSION, "edit": prepared.request,
        });
        let wire = io::MemberPolicyWire::prepare(command, request_id, end)
            .map_err(MemberPolicyEditError::Refused)?;
        pending
            .assert_ready_for_edit(prepared, admission)
            .map_err(MemberPolicyEditError::BeforeEffect)?;
        need(
            prepared.claim_unissued(),
            "WORKER_POOL_MEMBER_EDIT_ALREADY_SENT",
        )
        .map_err(MemberPolicyEditError::Refused)?;
        state.member_policy_edit.attempt = Some(Attempt {
            prepared: Arc::clone(&prepared.identity),
            request: prepared.request.clone(),
            end: prepared.end,
            phase: Phase::Applying(wire),
            first_cause: None,
        });
        match state.complete_policy_wire(end, true)? {
            MemberPolicyEditSettlement::Verified(verified) => Ok(verified),
            MemberPolicyEditSettlement::Committed(_) => unreachable!("only issued an apply"),
        }
    }

    pub fn commit_member_policy_edit(
        &mut self,
        prepared: &PreparedMemberPolicyEdit,
        verified: &MemberPolicyEditVerified,
        pending: &MemberPolicyPending,
        admission: &AdmissionLock,
    ) -> EditResult<MemberPolicyEditCommitted> {
        let state = self.state_mut();
        state
            .require_controller_active()
            .map_err(|_| MemberPolicyEditError::Retained)?;
        let attempt = state
            .member_policy_edit
            .attempt
            .as_ref()
            .ok_or(MemberPolicyEditError::Retained)?;
        if verified.assert_prepared(prepared).is_err()
            || !Arc::ptr_eq(&attempt.prepared, &prepared.identity)
            || !matches!(attempt.phase, Phase::Verified)
        {
            return Err(MemberPolicyEditError::Retained);
        }
        let end = state
            .edit_effect_end(attempt.end)
            .map_err(|_| MemberPolicyEditError::Retained)?;
        let request_id = fresh_id().map_err(|_| MemberPolicyEditError::Retained)?;
        let command = serde_json::json!({
            "verb": "commitMemberPolicy", "requestId": request_id,
            "version": MEMBER_POLICY_EDIT_VERSION, "operation": prepared.operation.as_str(),
        });
        let wire = io::MemberPolicyWire::prepare(command, request_id, end)
            .map_err(|_| MemberPolicyEditError::Retained)?;
        pending
            .assert_published_for_edit(prepared, admission)
            .map_err(MemberPolicyEditError::RetainedIntent)?;
        state
            .member_policy_edit
            .attempt
            .as_mut()
            .expect("original edit")
            .phase = Phase::Committing(wire);
        match state.complete_policy_wire(end, true)? {
            MemberPolicyEditSettlement::Committed(committed) => Ok(committed),
            MemberPolicyEditSettlement::Verified(_) => unreachable!("only issued a commit"),
        }
    }

    /// A bounded read of the original response. No new command is issued.
    pub fn settle_member_policy_edit(
        &mut self,
        prepared: &PreparedMemberPolicyEdit,
        end: Instant,
    ) -> EditResult<MemberPolicyEditSettlement> {
        let state = self.state_mut();
        let attempt = state
            .member_policy_edit
            .attempt
            .as_ref()
            .ok_or(MemberPolicyEditError::Retained)?;
        if !Arc::ptr_eq(&attempt.prepared, &prepared.identity) {
            return Err(MemberPolicyEditError::Retained);
        }
        // The command's original wire deadline never changes. The later,
        // read-only response wait is bounded by the same Prepared lifetime.
        let end = state
            .edit_effect_end(end.min(attempt.end))
            .map_err(|_| MemberPolicyEditError::Retained)?;
        state.complete_policy_wire(end, false)
    }
}

impl ControllerState {
    fn edit_effect_end(&self, end: Instant) -> Result<Instant> {
        let end = end.min(Instant::now() + Duration::from_secs(20));
        let end = self
            .binding
            .stop
            .deadline()
            .map_or(end, |stop| end.min(stop));
        need(Instant::now() < end, "WORKER_POOL_MEMBER_EDIT_DEADLINE")?;
        Ok(end)
    }

    fn complete_policy_wire(
        &mut self,
        end: Instant,
        transmit: bool,
    ) -> EditResult<MemberPolicyEditSettlement> {
        let attempt = self
            .member_policy_edit
            .attempt
            .as_mut()
            .expect("original edit");
        let (wire, apply) = match &mut attempt.phase {
            Phase::Applying(wire) => (wire, true),
            Phase::Committing(wire) => (wire, false),
            Phase::Verified => {
                return Ok(MemberPolicyEditSettlement::Verified(
                    MemberPolicyEditVerified {
                        prepared: Arc::clone(&attempt.prepared),
                    },
                ));
            }
        };
        let reply = (|| {
            let socket = self
                .client
                .as_mut()
                .ok_or(PoolError::Refused("WORKER_POOL_CHANNEL"))?;
            if transmit {
                wire.transmit(socket, end, &self.binding.stop)?;
            }
            wire.receive(socket, end, &self.binding.stop, &mut self.close_unknown)
        })();
        let reply = match reply {
            Ok(reply) if !self.close_unknown => reply,
            Ok(_) => return Err(MemberPolicyEditError::Retained),
            Err(error) => {
                attempt.first_cause.get_or_insert(error);
                return Err(MemberPolicyEditError::Retained);
            }
        };
        if apply
            && reply["phase"] == "memberPolicyRefused"
            && reply["known"] == true
            && reply["primaryError"].is_string()
        {
            let rejected = MemberPolicyEditRejected {
                prepared: Arc::clone(&attempt.prepared),
            };
            self.member_policy_edit.attempt = None;
            return Err(MemberPolicyEditError::Rejected(rejected));
        }
        let verified = if apply {
            "memberPolicyVerified"
        } else {
            "memberPolicyCommitted"
        };
        if reply["phase"] != verified || reply["known"] != true || !reply["primaryError"].is_null()
        {
            attempt
                .first_cause
                .get_or_insert(PoolError::Refused("WORKER_POOL_MEMBER_EDIT_REPLY"));
            return Err(MemberPolicyEditError::Retained);
        }
        if apply {
            attempt.phase = Phase::Verified;
            Ok(MemberPolicyEditSettlement::Verified(
                MemberPolicyEditVerified {
                    prepared: Arc::clone(&attempt.prepared),
                },
            ))
        } else {
            let request = &attempt.request;
            if let Err(error) = self.member_policy_edit.policies.commit(
                &self.policy,
                &request.employee,
                request.proposed,
            ) {
                attempt.first_cause.get_or_insert(error);
                return Err(MemberPolicyEditError::Retained);
            }
            self.member_policy_edit.revision = request.expected_revision + 1;
            let committed = MemberPolicyEditCommitted {
                prepared: Arc::clone(&attempt.prepared),
            };
            self.member_policy_edit.attempt = None;
            Ok(MemberPolicyEditSettlement::Committed(committed))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_policy_capability_is_optional_and_exact_version() {
        let mut state = EditState::default();
        state.negotiate(&serde_json::json!({"phase":"active"}));
        assert!(!state.supported);
        state.negotiate(&serde_json::json!({"memberPolicyEditVersion":1}));
        assert!(state.supported);
        for value in [
            serde_json::json!(2),
            serde_json::json!("1"),
            serde_json::Value::Null,
        ] {
            state.negotiate(&serde_json::json!({"memberPolicyEditVersion":value}));
            assert!(!state.supported);
        }
    }
}
