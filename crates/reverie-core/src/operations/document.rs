use super::*;
use crate::revision::StoreRevision;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationDocument {
    revision: StoreRevision,
    operations: BTreeMap<JournalId, Operation>,
}
impl OperationDocument {
    pub fn empty() -> Self {
        Self {
            revision: StoreRevision::ZERO,
            operations: BTreeMap::new(),
        }
    }
    pub fn try_new(
        revision: StoreRevision,
        operations: BTreeMap<JournalId, Operation>,
    ) -> Result<Self> {
        need(operations.len() <= MAX_OPERATIONS, "OPERATION_LIMIT")?;
        let mut builder = OperationDocumentBuilder::new(revision);
        for (key, operation) in operations {
            builder.push_unique(key, operation)?;
        }
        builder.finish()
    }
    pub fn revision(&self) -> StoreRevision {
        self.revision
    }
    pub fn operations(&self) -> &BTreeMap<JournalId, Operation> {
        &self.operations
    }
    pub fn replacing(&self, operation: Operation) -> Result<Self> {
        let mut operations = self.operations.clone();
        operations.insert(operation.data().id.clone(), operation);
        Self::try_new(
            self.revision
                .checked_next()
                .map_err(|_| OperationError::new("VERSION"))?,
            operations,
        )
    }
}
/// Linear, source-order validation for the named reader. A failed insertion
/// poisons this data builder; no partial valid document can escape afterwards.
pub struct OperationDocumentBuilder {
    document: OperationDocument,
    index: ClaimIndex,
    failure: Option<OperationError>,
}
impl OperationDocumentBuilder {
    pub fn new(revision: StoreRevision) -> Self {
        Self {
            document: OperationDocument {
                revision,
                operations: BTreeMap::new(),
            },
            index: ClaimIndex::default(),
            failure: None,
        }
    }
    pub fn push_unique(&mut self, key: JournalId, operation: Operation) -> Result<()> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let result = need(
            self.document.operations.len() < MAX_OPERATIONS,
            "OPERATION_LIMIT",
        )
        .and_then(|()| {
            need(
                !self.document.operations.contains_key(&key),
                "DUPLICATE_KEY",
            )
        })
        .and_then(|()| self.index.check(&key, &operation));
        if let Err(error) = result {
            self.failure = Some(error);
            return Err(error);
        }
        self.document.operations.insert(key, operation);
        Ok(())
    }
    pub fn finish(self) -> Result<OperationDocument> {
        match self.failure {
            Some(error) => Err(error),
            None => Ok(self.document),
        }
    }
}
type PoolIdentity = (JournalDigest, u64, u64);
#[derive(Default)]
struct ClaimIndex {
    seen: BTreeSet<(OperationScope, JournalId)>,
    reservations: BTreeSet<JournalId>,
    sids: BTreeSet<JournalId>,
    employees: BTreeSet<(JournalId, JournalId)>,
    pools: BTreeMap<JournalId, (PoolIdentity, u128)>,
}
impl ClaimIndex {
    fn check(&mut self, key: &JournalId, operation: &Operation) -> Result<()> {
        let op = operation.data();
        need(key == &op.id, "OPERATION_ID")?;
        need(
            self.seen
                .insert((op.scope.clone(), op.idempotency_key.clone())),
            "DUPLICATE_IDEMPOTENCY_KEY",
        )?;
        need(
            self.reservations.insert(op.reservation_id.clone())
                && self.sids.insert(op.reserved_sid.clone()),
            "DUPLICATE_RESERVATION",
        )?;
        if op.state == OperationState::Completed {
            return Ok(());
        }
        need(
            self.employees
                .insert((op.scope.company_id.clone(), op.request.employee_id.clone())),
            "EMPLOYEE_HAS_RETAINED_CLAIM",
        )?;
        let observed = op.observation.data();
        let pool = (
            observed.pool_revision_digest.clone(),
            observed.budget_bytes,
            observed.committed_bytes,
        );
        let (prior, held) = self
            .pools
            .entry(observed.pool_id.clone())
            .or_insert((pool.clone(), 0u128));
        need(*prior == pool, "POOL_RECONCILIATION_REQUIRED")?;
        *held += u128::from(op.delta_bytes);
        need(
            *held + u128::from(observed.committed_bytes) <= u128::from(observed.budget_bytes),
            "CAPACITY_EXHAUSTED",
        )?;
        Ok(())
    }
}
