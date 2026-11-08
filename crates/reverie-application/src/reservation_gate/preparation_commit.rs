//! Actual one-attempt policy CAS, installing-broker reload and journal ACK.
//! No caller candidate, path, validator, registry edit or proof callback enters.
use super::{preparation_phase::PublicationPhase, preparation_policy::PolicyPhase, *};
use reverie_contracts::{
    reservation_policy::{PolicyCandidateData, PreparedPolicyFields, PreparedPolicyRecord},
    worker_config,
};
use reverie_host::reservation_control::PolicyTransaction;
use std::path::Path;
impl RetainedPreparation {
    pub fn commit_configuration(&mut self) -> Result<CommittedPolicy> {
        self.commit_selected(None)
    }
    /// The selection must match this actual retained profile/native baseline.
    /// The caller still owns its real authenticated operation; selected DATA
    /// never grants admission, configuration publication or a native effect.
    pub fn commit_ram_configuration(
        &mut self,
        policy: &reverie_contracts::ram_migration::RamMigrationPolicy,
    ) -> Result<CommittedPolicy> {
        self.commit_selected(Some(policy))
    }
    fn commit_selected(
        &mut self,
        policy: Option<&reverie_contracts::ram_migration::RamMigrationPolicy>,
    ) -> Result<CommittedPolicy> {
        need(
            self.store.is_some(),
            "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED",
        )?;
        need(self.published, "RESOURCE_PREPARATION_PUBLICATION_REQUIRED")?;
        need(
            self.policy.is_none(),
            "RESOURCE_PREPARATION_CONFIG_ALREADY_ATTEMPTED",
        )?;
        let staged = self.stage_selected(policy)?;
        let candidate = Arc::new(crate::worker_validation::validate_captured(
            staged.configuration().clone(),
        )?);
        let path = self.gate.source_path.clone().ok_or(GateError::Refused(
            "RESOURCE_PREPARATION_CONFIG_FILE_REQUIRED",
        ))?;
        match self.commit_attempt(candidate, &path) {
            Ok(receipt) => Ok(CommittedPolicy::after_commit(
                self,
                receipt,
                policy.map(|policy| policy.digest().clone()),
            )),
            Err(error) => Err(GateError::PreparationConfigUncertain {
                cause: Box::new(finalized::<()>(Err(error), self.close_owned()).unwrap_err()),
            }),
        }
    }
    fn commit_attempt(
        &mut self,
        candidate: Arc<ValidatedWorkerSnapshot>,
        path: &Path,
    ) -> Result<PreparedPolicyRecord> {
        let gate = self.gate.clone();
        let admission = gate.admit(AdmissionBounds::default())?;
        let result = (|| {
            gate.finish_preparation(self, PublicationPhase::After)?;
            let installed = gate.installed.snapshot()?;
            gate.native_context()?
                .custody_loaded_policy(&installed, None)?;
            let transaction = PolicyTransaction::capture(path, gate.config()?.uid()?)?;
            let mut transaction = Some(transaction);
            let body = self.publish_policy(candidate, path, &mut transaction, installed);
            let closed = transaction.take().map_or(Ok(()), |transaction| {
                transaction.close().map_err(Into::into)
            });
            finalized(body, closed)
        })();
        match result {
            Ok(receipt) => finalized(
                Ok(receipt),
                admission.finish_preparation(self, PublicationPhase::After),
            ),
            Err(error) => admission.conclude(Err(error)),
        }
    }
    fn publish_policy(
        &mut self,
        candidate: Arc<ValidatedWorkerSnapshot>,
        path: &Path,
        transaction: &mut Option<PolicyTransaction>,
        before: Arc<ValidatedWorkerSnapshot>,
    ) -> Result<PreparedPolicyRecord> {
        let original = crate::worker_validation::load_owner_config(path)?;
        need(
            worker_config::equivalent(original.configuration(), self.source_configuration()),
            "RESOURCE_PREPARATION_CONFIG_CHANGED",
        )?;
        self.policy = Some(PolicyPhase {
            before,
            installed_snapshot: None,
            candidate: candidate.clone(),
            binding: transaction.as_ref().expect("actual transaction").binding(),
            published: false,
            installed: false,
        });
        let bytes = PolicyCandidateData::capture(candidate.configuration())?;
        let gate = self.gate.clone();
        let held = transaction.as_mut().expect("actual transaction");
        held.publish_attempt(
            gate.config()?.as_ref(),
            self.operation_id(),
            self.source_configuration(),
            &bytes,
        )?;
        held.write_candidate(&bytes)?;
        gate.native_context()?
            .custody_policy(&self.policy.as_ref().expect("latched phase").binding, None)?;
        held.assert_directory_current()?;
        gate.finish_preparation(self, PublicationPhase::After)?;
        // Adjacent signature/rename/fsync and every transaction close complete
        // before any subsequent loader or native producer.
        transaction.take().expect("actual transaction").publish()?;
        need(
            worker_config::equivalent(
                crate::worker_validation::load_owner_config(path)?.configuration(),
                candidate.configuration(),
            ),
            "RESOURCE_PREPARATION_CONFIG_CHANGED",
        )?;
        let phase = self.policy.as_mut().expect("latched phase");
        phase.binding.observe_published_file()?;
        phase.published = true;
        gate.reload_current(Some(self))?;
        need(
            worker_config::equivalent(gate.config()?.configuration(), candidate.configuration())
                && worker_config::equivalent(
                    crate::worker_validation::load_owner_config(path)?.configuration(),
                    candidate.configuration(),
                ),
            "RESOURCE_PREPARATION_RELOAD_UNCONFIRMED",
        )?;
        gate.finish_preparation(self, PublicationPhase::After)?;
        let record = PreparedPolicyRecord::from_observed_data(PreparedPolicyFields {
            operation: self.view.record(),
            profile: self.profile(),
            before: self.source_configuration(),
            after: &bytes,
            source_binding: &self.terminal.observed.fields().source_binding,
        })?;
        reservation_control::publish_prepared_policy(gate.config()?.as_ref(), &record)?;
        self.record_policy_ack(&record)?;
        Ok(record)
    }
}
