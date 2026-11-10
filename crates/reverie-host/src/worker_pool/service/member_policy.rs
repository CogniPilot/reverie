use super::{member::InspectedMember, protocol::MemberPolicyEdit, *};
use crate::worker_pool::member::{MemberComponent, MemberProcess};
use reverie_contracts::worker_pool::WorkerPoolMemberPolicy;

fn check_candidate(
    birth: &WorkerPoolPolicy,
    policies: &crate::worker_pool::member_policy::MemberPolicies,
    revision: u64,
    request: &MemberPolicyEdit,
    end: Instant,
) -> Result<()> {
    check(end)?;
    need(
        revision == request.expected_revision
            && revision.checked_add(1).is_some()
            && policies.effective(birth, &request.employee)? == request.before,
        "WORKER_POOL_MEMBER_EDIT_REVISION",
    )?;
    need(
        request.before != request.proposed
            && (request.proposed.memory_high_mib() < birth.memory_max_mi_b
                || request.proposed
                    == crate::worker_pool::member_policy::birth_policy(birth, &request.employee)?),
        "WORKER_POOL_MEMBER_EDIT_POLICY",
    )
}

pub(super) enum EditReply {
    Verified,
    Committed,
    Refused(PoolError),
    Retained,
}

impl EditReply {
    pub(super) fn phase(&self) -> &'static str {
        match self {
            Self::Verified => "memberPolicyVerified",
            Self::Committed => "memberPolicyCommitted",
            Self::Refused(_) => "memberPolicyRefused",
            Self::Retained => "memberPolicyRetained",
        }
    }

    pub(super) fn known(&self) -> bool {
        !matches!(self, Self::Retained)
    }
}

pub(super) struct EditAttempt {
    request: MemberPolicyEdit,
    phase: EditPhase,
}

enum EditPhase {
    Applying,
    Verified,
    Retained(EditFailure),
}

enum EditFailure {
    Refused(PoolError),
    NativeClose(PoolError),
    Retained(MemberComponent),
}

impl EditFailure {
    fn before_write(error: PoolError) -> Self {
        if error.close_unknown() {
            Self::NativeClose(error)
        } else {
            Self::Refused(error)
        }
    }
}

impl EditAttempt {
    pub(super) fn failure(&self) -> Option<&PoolError> {
        match &self.phase {
            EditPhase::Retained(EditFailure::Refused(error) | EditFailure::NativeClose(error)) => {
                Some(error)
            }
            EditPhase::Retained(EditFailure::Retained(owner)) => Some(owner.cause()),
            _ => None,
        }
    }

    pub(super) fn close_components(&mut self) -> Result<()> {
        match &mut self.phase {
            EditPhase::Retained(EditFailure::Retained(owner)) => owner.close(),
            _ => Ok(()),
        }
    }
}

impl State {
    pub(super) fn apply_member_policy(
        &mut self,
        policy: &ControllerPoolPolicy,
        peer: &mut ControllerPeer<'_>,
        request: &MemberPolicyEdit,
        end: Instant,
    ) -> EditReply {
        if self.edit.is_some() {
            return EditReply::Retained;
        }
        let permitted = (|| {
            need(
                self.primary.is_none() && self.member_failure.is_none(),
                "WORKER_POOL_ORIGINAL_ATTEMPT_RETAINED",
            )?;
            check_candidate(
                policy.data(),
                &self.member_policies,
                self.member_policy_revision,
                request,
                end,
            )
        })();
        if let Err(error) = permitted {
            return EditReply::Refused(error);
        }
        self.edit = Some(EditAttempt {
            request: request.clone(),
            phase: EditPhase::Applying,
        });
        match self.observe_member_policy(policy, peer, request, request.before, true, end) {
            Ok(()) => {
                self.edit.as_mut().expect("original edit").phase = EditPhase::Verified;
                EditReply::Verified
            }
            Err(EditFailure::Refused(error)) => {
                self.edit = None;
                EditReply::Refused(error)
            }
            Err(error) => {
                self.edit.as_mut().expect("original edit").phase = EditPhase::Retained(error);
                EditReply::Retained
            }
        }
    }

    pub(super) fn commit_member_policy(
        &mut self,
        policy: &ControllerPoolPolicy,
        peer: &mut ControllerPeer<'_>,
        operation: &str,
        end: Instant,
    ) -> EditReply {
        let Some(attempt) = self.edit.as_ref() else {
            return EditReply::Refused(PoolError::Refused("WORKER_POOL_MEMBER_EDIT_ABSENT"));
        };
        if attempt.request.operation != operation || !matches!(attempt.phase, EditPhase::Verified) {
            return EditReply::Retained;
        }
        let request = attempt.request.clone();
        let committed = self
            .observe_member_policy(policy, peer, &request, request.proposed, false, end)
            .and_then(|()| {
                self.member_policies
                    .commit(policy.data(), &request.employee, request.proposed)
                    .map_err(EditFailure::Refused)
            });
        match committed {
            Ok(()) => {
                self.member_policy_revision = request.expected_revision + 1;
                self.edit = None;
                EditReply::Committed
            }
            Err(error) => {
                self.edit.as_mut().expect("original edit").phase = EditPhase::Retained(error);
                EditReply::Retained
            }
        }
    }

    fn observe_member_policy(
        &self,
        policy: &ControllerPoolPolicy,
        peer: &mut ControllerPeer<'_>,
        request: &MemberPolicyEdit,
        expected: WorkerPoolMemberPolicy,
        apply: bool,
        end: Instant,
    ) -> std::result::Result<(), EditFailure> {
        check(end).map_err(EditFailure::Refused)?;
        let inspected = InspectedMember::capture(
            policy,
            &request.employee,
            &request.session,
            &request.container,
            expected,
        )
        .map_err(EditFailure::before_write)?;
        need(
            inspected.pid == request.pid,
            "WORKER_POOL_MEMBER_EDIT_IDENTITY",
        )
        .map_err(EditFailure::Refused)?;
        let pool = self
            .installed_member_pool(policy)
            .map_err(EditFailure::Refused)?;
        let mut owner = match OpenedPoolMember::capture_with_policy(
            &pool,
            &request.container,
            inspected.pid,
            inspected.limits,
            Ok(expected.memory_high_bytes()),
            MemberProcess::Running,
        ) {
            Ok(owner) => owner,
            Err(failure) => {
                return Err(match failure.close_for_edit() {
                    Ok(error) => EditFailure::Refused(error),
                    Err(owner) => EditFailure::Retained(owner),
                });
            }
        };
        let mut issued = false;
        let result = (|| {
            owner.assert_edit_target(&request.start, request.leaf, end)?;
            inspected.assert_current(policy, &request.container)?;
            if apply {
                owner.apply_edit(peer, request.proposed, end, &mut issued)?;
                inspected.assert_current(policy, &request.container)?;
                owner.assert_edit_target(&request.start, request.leaf, end)?;
            }
            peer.require_original_broker()?;
            check(end)
        })();
        let closed = owner.close();
        match finalized(result, closed) {
            Ok(()) => Ok(()),
            Err(error) if issued || error.close_unknown() => {
                Err(EditFailure::Retained(owner.into_edit_component(error)))
            }
            Err(error) => Err(EditFailure::Refused(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_pool::member_policy::MemberPolicies;

    #[test]
    fn initial_inspection_close_failure_is_never_a_known_no_write_receipt() {
        let refused = PoolError::Refused("WORKER_POOL_MEMBER_INSPECTION");
        assert!(matches!(
            EditFailure::before_write(refused),
            EditFailure::Refused(_)
        ));
        let close = PoolError::MetadataClose(Box::new(PoolError::Io(std::io::Error::other(
            "fixture checked close",
        ))));
        let nested = PoolError::Finalization(
            Box::new(PoolError::Refused("WORKER_POOL_MEMBER_INSPECTION")),
            Box::new(close),
        );
        assert!(matches!(
            EditFailure::before_write(nested),
            EditFailure::NativeClose(error) if error.close_unknown()
        ));
    }

    #[test]
    fn stale_member_edit_is_refused_even_after_values_return_to_birth() {
        let employee = "22222222-2222-4222-8222-222222222222";
        let birth = WorkerPoolPolicy::decode(
            &serde_json::to_vec(&serde_json::json!({
                "version":1, "purpose":reverie_contracts::worker_pool::PURPOSE,
                "deployment":"fixture", "instanceRoot":"/home/fixture/reverie",
                "engineId":"11111111-1111-4111-8111-111111111111",
                "anchorImage":format!("sha256:{}", "a".repeat(64)),
                "controllerImage":format!("sha256:{}", "b".repeat(64)),
                "websiteContainer":"c".repeat(64), "brokerUid":1000, "brokerGid":1000,
                "memoryMaxMiB":49152, "poolTasksMax":8192, "cpuWeight":100, "allowedCpus":[0],
                "employeeMemoryHighMiB":{(employee):8192}
            }))
            .unwrap(),
        )
        .unwrap();
        let before = WorkerPoolMemberPolicy::new(8192, 100).unwrap();
        let proposed = WorkerPoolMemberPolicy::new(16384, 200).unwrap();
        let request = MemberPolicyEdit {
            operation: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into(),
            employee: employee.into(),
            session: "33333333-3333-4333-8333-333333333333".into(),
            container: "d".repeat(64),
            pid: 7,
            start: "100".into(),
            leaf: (7, 8),
            before,
            proposed,
            expected_revision: 0,
        };
        let mut policies = MemberPolicies::default();
        let end = Instant::now() + Duration::from_secs(5);
        check_candidate(&birth, &policies, 0, &request, end).unwrap();
        policies.commit(&birth, employee, proposed).unwrap();
        policies.commit(&birth, employee, before).unwrap();
        assert_eq!(policies.effective(&birth, employee).unwrap(), before);
        assert_eq!(
            check_candidate(&birth, &policies, 2, &request, end)
                .unwrap_err()
                .code(),
            "WORKER_POOL_MEMBER_EDIT_REVISION",
        );
    }
}
