use super::*;
use reverie_contracts::operations_v1;
use reverie_core::revision::ProfileVersion;
use std::collections::BTreeSet;
fn allocate(selected: &Option<JournalId>) -> Result<JournalId> {
    match selected {
        Some(value) => Ok(value.clone()),
        None => Ok(JournalId::parse(&private_fs::random_uuid()?)?),
    }
}
impl OperationStore {
    fn observe(
        &self,
        scope: &OperationScope,
        proposed: &OperationRequest,
    ) -> Result<CapacityObservation> {
        let observer = self
            .observer
            .as_ref()
            .ok_or(JournalError::refusal("MISSING_CAPACITY_OBSERVER"))?;
        let observed = observer.observe(scope, &proposed.pool_id, &proposed.employee_id)?;
        need(
            operations_v1::observation_digest(&observed) == proposed.observation_digest,
            "STALE_CAPACITY_SNAPSHOT",
        )?;
        let o = observed.data();
        need(
            o.employee_id == proposed.employee_id
                && o.pool_id == proposed.pool_id
                && o.source_binding_digest == proposed.source_binding_digest
                && o.profile_version == proposed.profile_version,
            "OBSERVATION_BINDING",
        )?;
        Ok(observed)
    }
    /// Preselected IDs are fixed-provider private draft data, never approval or
    /// public request fields. Replays return a view and never a fresh handle.
    pub fn claim(
        &self,
        scope: &OperationScope,
        key: &JournalId,
        proposed: &OperationRequest,
        selection: &ClaimSelection,
    ) -> Result<(OperationView, Option<OperationHandle>)> {
        self.locked(scope, false, None, |inner, current, context, lock| {
            let current = current.expect("existing read");
            if let Some(op) = current
                .operations()
                .values()
                .find(|op| op.data().scope == *scope && op.data().idempotency_key == *key)
            {
                let data = op.data();
                need(
                    data.request == *proposed
                        && selection
                            .operation_id
                            .as_ref()
                            .is_none_or(|id| id == &data.id)
                        && selection
                            .reservation_id
                            .as_ref()
                            .is_none_or(|id| id == &data.reservation_id)
                        && selection
                            .reserved_sid
                            .as_ref()
                            .is_none_or(|id| id == &data.reserved_sid),
                    "IDEMPOTENCY_CONFLICT",
                )?;
                return Ok((inner.view(op), None));
            }
            need(
                current.operations().len() < MAX_OPERATIONS,
                "OPERATION_LIMIT",
            )?;
            need(
                !current.operations().values().any(|op| {
                    op.data().scope.company_id == scope.company_id
                        && op.data().state != OperationState::Completed
                        && op.data().request.employee_id == proposed.employee_id
                }),
                "EMPLOYEE_HAS_RETAINED_CLAIM",
            )?;
            let observed = self.observe(scope, proposed)?;
            let occupied = occupied(&current);
            if let Some(target) = &selection.reserved_sid {
                need(target != &observed.data().current_sid, "RESERVATION_ROLES")?;
                need(!occupied.contains(target), "RESERVATION_TARGET_IN_USE")?;
            }
            let opid = allocate(&selection.operation_id)?;
            let reservation = allocate(&selection.reservation_id)?;
            let target = allocate(&selection.reserved_sid)?;
            let allocated = [
                opid.clone(),
                reservation.clone(),
                target.clone(),
                observed.data().current_sid.clone(),
            ]
            .into_iter()
            .collect::<BTreeSet<_>>();
            need(allocated.len() == 4, "RESERVATION_ROLES")?;
            need(
                [&opid, &reservation, &target]
                    .iter()
                    .all(|id| !occupied.contains(*id)),
                "RESERVATION_ALLOCATION_IN_USE",
            )?;
            let operation = Operation::try_new(OperationData {
                id: opid.clone(),
                scope: scope.clone(),
                idempotency_key: key.clone(),
                request: proposed.clone(),
                request_digest: operations_v1::request_digest(proposed),
                reservation_id: reservation,
                reserved_sid: target,
                delta_bytes: proposed
                    .requested_memory_bytes
                    .get()
                    .saturating_sub(observed.data().current_memory_bytes.get()),
                observation: observed.clone(),
                version: ProfileVersion::try_new(1).expect("phase one"),
                state: OperationState::Reserved,
                last_receipt_digest: None,
                reason: None,
            })?;
            let document = current.replacing(operation.clone())?;
            let fence = || {
                need(
                    self.observe(scope, proposed)? == observed,
                    "CAPACITY_CHANGED",
                )
            };
            self.commit(inner, lock, scope, &document, context, Some(&fence))?;
            let token = Arc::new(());
            inner.leases.insert(opid.clone(), token.clone());
            Ok((
                inner.view(&operation),
                Some(OperationHandle { id: opid, token }),
            ))
        })
    }
}
fn occupied(document: &OperationDocument) -> BTreeSet<JournalId> {
    document
        .operations()
        .values()
        .flat_map(|op| {
            let data = op.data();
            [
                data.id.clone(),
                data.reservation_id.clone(),
                data.reserved_sid.clone(),
                data.observation.data().current_sid.clone(),
            ]
        })
        .collect()
}
