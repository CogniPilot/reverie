//! OS nomination DATA only. It cannot change a live policy or grant consent.
use super::*;
use crate::storage_identity::Metadata;
use reverie_core::ids::ProfileEmployeeId;
use std::collections::BTreeSet;
impl PoolInstallationRequestData {
    /// A fixed-artifact proposal successor only; all principal and non-image
    /// values remain the same and still need independent website consent.
    pub fn with_fixed_images(&self, images: [String; 2]) -> Result<Self> {
        need(images[0] != images[1], "POOL_NOMINATION_FIXED_IMAGES")?;
        let mut policy = self.policy.clone();
        policy.anchor_image = images[0].clone();
        policy.controller_image = images[1].clone();
        Self::from_enrollment(
            &crate::worker_config::compact_data(&self.principal.value()),
            &policy,
        )
    }
    pub fn with_employee_highs(
        &self,
        company: &Metadata,
        default: u32,
        overrides: &[(ProfileEmployeeId, u32)],
    ) -> Result<Self> {
        let valid = |n: u32| (512..crate::worker_pool::MEMORY_MAX_MIB).contains(&n);
        need(
            valid(default) && overrides.len() <= 256,
            "POOL_NOMINATION_SOFT_THRESHOLD",
        )?;
        let records = company
            .company_records()
            .map_err(|e| ResourceActorDataError(e.code()))?;
        let mut highs = BTreeMap::new();
        for row in records.records() {
            let id = row
                .canonical_identity()
                .map_err(|e| ResourceActorDataError(e.code()))?;
            need(
                highs.insert(id.as_str().to_owned(), default).is_none(),
                "POOL_NOMINATION_COMPLETE_COMPANY_REQUIRED",
            )?;
        }
        need(
            !highs.is_empty()
                && highs.len() <= 256
                && highs
                    .keys()
                    .eq(self.policy.employee_memory_high_mi_b.keys()),
            "POOL_NOMINATION_COMPLETE_COMPANY_REQUIRED",
        )?;
        let mut selected = BTreeSet::new();
        for (id, high) in overrides {
            need(
                valid(*high) && selected.insert(id.as_str()),
                "POOL_NOMINATION_OVERRIDE_INVALID",
            )?;
            let value = highs
                .get_mut(id.as_str())
                .ok_or(ResourceActorDataError("POOL_NOMINATION_OVERRIDE_EMPLOYEE"))?;
            *value = *high;
        }
        let mut policy = self.policy.clone();
        policy.employee_memory_high_mi_b = highs;
        Self::from_enrollment(
            &crate::worker_config::compact_data(&self.principal.value()),
            &policy,
        )
    }
}
