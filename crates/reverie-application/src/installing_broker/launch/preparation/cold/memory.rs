//! Fresh App policy joins around the actual Host row/outer/inner target owners.
//! Resolver refusal always attempts the real pending phase's checked finalizer.
use super::*;
use reverie_contracts::{
    reservation_engine::{ObservedMemoryPolicy, ReservationConfiguration},
    worker_config::{self, WorkerPolicyDigest},
};
use reverie_host::worker_laptop::{
    ConfiguredMemory, MemoryConfiguration, WorkerMemoryBegin, WorkerMemoryEffect,
};
impl ColdBody<'_> {
    pub(super) fn configure_memory(&mut self) -> Result<ConfiguredMemory, ColdError> {
        let network = self.network();
        let connection = self.scope.preparing.admitted.request.connection.clone();
        let source = self.broker().configuration()?;
        let selected = ReservationConfiguration::capture(source.configuration().clone())
            .memory_policies_enabled();
        let effective = selected.then(|| self.fresh_effective()).transpose()?;
        let started = self
            .creation
            .as_ref()
            .expect("actual creation")
            .started
            .as_ref()
            .expect("actual start ACK");
        match network.begin_memory(started, &connection, effective.as_ref())? {
            WorkerMemoryBegin::Configured(configured) => return Ok(configured),
            WorkerMemoryBegin::Policy(policy) => self.memory = Some(MemoryJoin::Policy(policy)),
            WorkerMemoryBegin::Rejected | WorkerMemoryBegin::Retained => {
                return Err(Self::phase_refused(
                    &network,
                    "WORKER_COLD_MEMORY_INSPECTION_UNCONFIRMED",
                ));
            }
        }
        let digest = match self.fresh_digest() {
            Ok(digest) => digest,
            Err(primary) => return Err(self.reject_memory(primary)),
        };
        let Some(MemoryJoin::Policy(policy)) = &self.memory else {
            unreachable!("actual policy join");
        };
        let applied = match network.apply_memory(policy, &connection, &digest) {
            Ok(value) => value,
            Err(primary) => return Err(self.reject_memory(primary.into())),
        };
        match applied {
            WorkerMemoryEffect::Readback(readback) => {
                self.memory = Some(MemoryJoin::Readback(readback))
            }
            WorkerMemoryEffect::Rejected | WorkerMemoryEffect::Retained => {
                return Err(Self::phase_refused(
                    &network,
                    "WORKER_COLD_MEMORY_WRITE_UNCONFIRMED",
                ));
            }
        }
        let (resources, digest) = match self.readback_policy() {
            Ok(value) => value,
            Err(primary) => return Err(self.reject_memory(primary)),
        };
        let Some(MemoryJoin::Readback(readback)) = &self.memory else {
            unreachable!("actual outer target retained");
        };
        let finished =
            match network.finish_memory(readback, &connection, &resources, digest.as_ref()) {
                Ok(value) => value,
                Err(primary) => return Err(self.reject_memory(primary.into())),
            };
        match finished {
            MemoryConfiguration::Configured(configured) => {
                self.memory = None;
                Ok(configured)
            }
            MemoryConfiguration::Rejected | MemoryConfiguration::Retained => Err(
                Self::phase_refused(&network, "WORKER_COLD_MEMORY_READBACK_UNCONFIRMED"),
            ),
        }
    }
    fn fresh_effective(&self) -> Result<EffectiveWorkerConfig, ColdError> {
        let source = self.broker().configuration()?;
        crate::resource_staging::effective_config(
            source.configuration().clone(),
            self.scope.preparing.admitted.request().session(),
        )
        .map_err(PreparationError::from)
        .map_err(Into::into)
    }
    fn fresh_digest(&self) -> Result<WorkerPolicyDigest, ColdError> {
        Ok(worker_config::policy_digest(&self.fresh_effective()?))
    }
    fn readback_policy(
        &self,
    ) -> Result<(EffectiveWorkerConfig, Option<WorkerPolicyDigest>), ColdError> {
        let resources = self.fresh_effective()?;
        let policy =
            ObservedMemoryPolicy::from_effective(&resources).map_err(PreparationError::from)?;
        let digest = policy.is_some().then(|| self.fresh_digest()).transpose()?;
        Ok((resources, digest))
    }
    fn reject_memory(&self, primary: ColdError) -> ColdError {
        let network = self.network();
        let connection = &self.scope.preparing.admitted.request.connection;
        let closed = match self.memory.as_ref().expect("actual pending memory phase") {
            MemoryJoin::Policy(policy) => network.reject_memory_policy(policy, connection),
            MemoryJoin::Readback(readback) => network.reject_memory_readback(readback, connection),
        };
        match closed {
            Ok(MemoryConfiguration::Rejected) => primary,
            Ok(_) => error::finalized(
                primary,
                Self::phase_refused(&network, "WORKER_COLD_MEMORY_CLEANUP_UNCONFIRMED"),
            ),
            Err(secondary) => error::finalized(primary, secondary.into()),
        }
    }
}
