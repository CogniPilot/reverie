use super::*;
use reverie_contracts::worker_pool::WorkerPoolProvider;
impl RevisionOwner {
    pub(super) fn prepare(&mut self) -> Result<()> {
        let root = os_root()?;
        self.nominal.selection = root.join("worker-pool/registration-request.json");
        let source = self
            .nominal
            .source
            .as_ref()
            .ok_or(PoolNominationError::Refused(
                "POOL_NOMINATION_ORIGINAL_SOURCE_REQUIRED",
            ))?
            .clone();
        need(
            WorkerPoolProvider::from_config(self.nominal.config.configuration())
                .map_err(|_| PoolNominationError::Refused("POOL_NOMINATION_PROVIDER"))?
                .is_none(),
            "POOL_NOMINATION_ALREADY_INSTALLED",
        )?;
        self.stopped = Some(
            capture_stopped_worker_service_for_role(
                &source,
                self.nominal.end,
                NativeWorkerServiceRole::PoolOfferV1,
            )
            .map_err(|cause| self.keep_service(cause))?,
        );
        self.nominal.end = self
            .nominal
            .end
            .min(self.stopped.as_ref().expect("original stop").end());
        self.locks = Some(
            match ImageMaintenanceLocks::capture(
                &source,
                self.nominal.config.configuration(),
                self.nominal.end,
            ) {
                Ok(locks) => locks,
                Err(cause) => {
                    let code = cause.cause().code();
                    self.lock_failure = Some(cause);
                    return Err(PoolNominationError::Refused(code));
                }
            },
        );
        self.nominal.prepare()?;
        let original = self.nominal.request.as_ref().expect("original proposal");
        need(
            original.digest() == &self.expected,
            "POOL_NOMINATION_EXPECTED_DIGEST_CHANGED",
        )?;
        let principal = serde_json::to_vec(&serde_json::json!({"accountId":original.principal().account_id(),
            "personId":original.principal().person_id(),"sessionEpoch":original.principal().session_epoch()}))
            .map_err(|_| PoolNominationError::Refused("POOL_NOMINATION_PRINCIPAL"))?;
        self.nominal.derived = Some(NominationDerivation::capture(
            &self.nominal.runtime,
            self.nominal.end,
        ));
        let (fresh, _) = self
            .nominal
            .derived
            .as_mut()
            .expect("same actual derivation")
            .derive(
                &self.nominal.runtime,
                &self.nominal.config,
                self.nominal.images.as_ref().expect("fixed images"),
                &principal,
                &root,
            )?;
        let mut nonhigh = fresh.policy().clone();
        nonhigh.employee_memory_high_mi_b = original.policy().employee_memory_high_mi_b.clone();
        need(
            nonhigh == *original.policy(),
            "POOL_NOMINATION_NONHIGH_BINDINGS_CHANGED",
        )?;
        self.next = Some(
            self.nominal
                .derived
                .as_ref()
                .expect("actual company")
                .revised_highs(original, self.default, &self.overrides)?,
        );
        need(
            self.next.as_ref().expect("next").digest() != original.digest(),
            "POOL_NOMINATION_UNCHANGED",
        )?;
        self.nominal
            .derived
            .as_mut()
            .expect("actual census")
            .assert_uninstalled(&self.nominal.runtime, original.policy())?;
        self.nominal.assert_preflight()?;
        self.stopped
            .as_mut()
            .expect("same stopped Offer")
            .revalidate()?;
        self.locks
            .as_mut()
            .expect("same locks")
            .assert_held_current()?;
        Ok(())
    }
}
