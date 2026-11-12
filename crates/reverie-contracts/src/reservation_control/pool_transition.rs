//! Establish-only denial fence DATA, never fleet or container-effect authority.
use super::*;
use reverie_core::operations::{JournalDigest, JournalId, OperationScope};

/// Closed references to a future real cohort approval. These references alone
/// authorize nothing; the lower fence only prevents subsequent admissions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolTransitionSelection {
    operation: JournalId,
    preview: JournalId,
    cohort: JournalDigest,
    pool_policy: JournalDigest,
    coverage: JournalDigest,
    revision: JournalDigest,
}
impl PoolTransitionSelection {
    pub fn new(
        operation: JournalId,
        preview: JournalId,
        cohort: JournalDigest,
        pool_policy: JournalDigest,
        coverage: JournalDigest,
        revision: JournalDigest,
    ) -> Self {
        Self {
            operation,
            preview,
            cohort,
            pool_policy,
            coverage,
            revision,
        }
    }
    pub fn operation_id(&self) -> &JournalId {
        &self.operation
    }
    /// Canonical binding DATA, shared by the native pending writer and the
    /// distinct fleet consent protocol. This never grants drain authority.
    pub(crate) fn approval_value(&self) -> Value {
        let text = |value: &str| Value(Node::String(key(value)));
        Value(Node::Object(BTreeMap::from([
            (key("operationId"), text(self.operation.as_str())),
            (key("previewId"), text(self.preview.as_str())),
            (key("cohortDigest"), text(self.cohort.as_str())),
            (key("poolPolicyDigest"), text(self.pool_policy.as_str())),
            (key("coverageDigest"), text(self.coverage.as_str())),
            (key("revisionDigest"), text(self.revision.as_str())),
        ])))
    }
}
pub struct PoolTransitionIntent {
    selected: PoolTransitionSelection,
    bytes: Vec<u8>,
}
impl PoolTransitionIntent {
    /// Read-only reconstruction of one existing denial record. Matching it
    /// grants no old-operation completion, replay or archive authority.
    pub fn decode_pending(
        raw: &[u8],
        scope: &OperationScope,
        binding: &ControlBinding,
        config: &EffectiveWorkerConfig,
    ) -> Result<Self> {
        if raw.is_empty() || raw.len() > 4096 {
            return Err(ControlDataError::BindingSchema);
        }
        let value = crate::legacy_json::decode_strict_bytes(raw)
            .map_err(|_| ControlDataError::BindingSchema)?;
        let fields = object(&value)?;
        let text = |name: &str| -> Result<String> {
            let Value(Node::String(value)) = field(fields, name)? else {
                return Err(ControlDataError::BindingSchema);
            };
            value
                .0
                .iter()
                .copied()
                .map(char::from_u32)
                .collect::<Option<String>>()
                .ok_or(ControlDataError::BindingSchema)
        };
        let id = |name| JournalId::parse(&text(name)?).map_err(|_| ControlDataError::BindingSchema);
        let hash =
            |name| JournalDigest::parse(&text(name)?).map_err(|_| ControlDataError::BindingSchema);
        let selected = PoolTransitionSelection::new(
            id("operationId")?,
            id("previewId")?,
            hash("cohortDigest")?,
            hash("poolPolicyDigest")?,
            hash("coverageDigest")?,
            hash("revisionDigest")?,
        );
        let intent = Self::capture(&selected, scope, binding, config)?;
        if intent.bytes != raw {
            return Err(ControlDataError::BindingSchema);
        }
        Ok(intent)
    }
    pub fn pool_policy_digest(&self) -> &JournalDigest {
        &self.selected.pool_policy
    }
    pub fn capture(
        selected: &PoolTransitionSelection,
        scope: &OperationScope,
        binding: &ControlBinding,
        config: &EffectiveWorkerConfig,
    ) -> Result<Self> {
        if selected.revision.as_str() != crate::worker_config::config_digest(config).to_hex()
            || binding.domain() != &domain_digest(config)?
        {
            return Err(ControlDataError::DomainChanged);
        }
        let text = |value: &str| Value(Node::String(key(value)));
        let mut document = selected.approval_value();
        let Node::Object(fields) = &mut document.0 else {
            unreachable!("closed transition selection");
        };
        fields.extend([
            (key("schema"), text("reverie-pool-transition-pending-v1")),
            (key("state"), text("RECONCILIATION_REQUIRED")),
            (key("companyId"), text(scope.company_id.as_str())),
            (
                key("ownerScopeDigest"),
                text(scope.owner_scope_digest.as_str()),
            ),
            (key("configurationDigest"), text(&binding.domain().to_hex())),
        ]);
        Ok(Self {
            selected: selected.clone(),
            bytes: crate::worker_config::compact_data(&document),
        })
    }
    pub fn operation_id(&self) -> &JournalId {
        self.selected.operation_id()
    }
    /// The original complete selection DATA; copied values grant no effects.
    pub fn selection(&self) -> &PoolTransitionSelection {
        &self.selected
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn assert_configuration(&self, config: &EffectiveWorkerConfig) -> Result<()> {
        if self.selected.revision.as_str() == crate::worker_config::config_digest(config).to_hex() {
            Ok(())
        } else {
            Err(ControlDataError::DomainChanged)
        }
    }
}
