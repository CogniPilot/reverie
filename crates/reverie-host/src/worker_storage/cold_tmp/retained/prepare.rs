//! Original pre-Office retained transaction on the actual LaunchStorage.
//! Only acknowledged fixed renames occur; no old-tree walk/removal exists.
use super::super::{admission::Admission, leases::Bases, *};
use super::{
    held::{Held, Slot},
    ready::{PENDING, Ready},
    references,
    scope::RetirementPaths,
};
use crate::{worker_launch::ObservedCreatePlan, worker_runtime::WorkerRuntime};
use reverie_contracts::worker_cold_tmp::{
    ColdConfiguration, ColdStrategy, ReferenceReport, RetainedRecordEpoch, RetainedRecordIdentity,
    retained_intent_record, retained_keep_record, retained_prepared_record,
};
use reverie_core::ids::NativeOperationId;
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, time::Duration};
type OwnerResult<T> = std::result::Result<T, StorageOwnerError>;

pub(in crate::worker_storage::cold_tmp) fn run(
    runtime: &WorkerRuntime,
    storage: &mut LaunchStorage,
    plan: &ObservedCreatePlan,
    admission: &mut Admission,
    ceiling: Instant,
) -> OwnerResult<Ready> {
    let source = plan.source();
    let policy = ColdConfiguration::capture(source)
        .map_err(StorageOwnerError::ColdData)?
        .ok_or(StorageOwnerError::Refused("WORKER_COLD_POLICY_REQUIRED"))?;
    require(
        policy.strategy() == ColdStrategy::RetainAndReplace,
        "WORKER_COLD_RETAINED_STRATEGY_REQUIRED",
    )?;
    storage.require_no_cold_pending()?;
    crate::worker_validation::observe_cold_policy(source).map_err(StorageOwnerError::Cold)?;
    let config = Configuration::capture(source).map_err(StorageOwnerError::Storage)?;
    let original = super::super::super::temporary::path_text(&config, storage.paths())
        .map_err(StorageOwnerError::Storage)?;
    let target = storage.prepare_temporary()?;
    require(
        native::python_path(
            &original
                .scratch()
                .join(&PosixPath::from_scalar_text("tmp"))
                .codepoints(),
        )
        .map_err(StorageOwnerError::Path)?
            == target,
        "WORKER_COLD_TMP_BINDING",
    )?;
    let mut entropy = [0; 16];
    getrandom::getrandom(&mut entropy)
        .map_err(|error| StorageOwnerError::Path(std::io::Error::other(error.to_string())))?;
    let attempt = NativeOperationId::from_random_bytes(entropy);
    let end = (Instant::now() + Duration::from_secs(30)).min(ceiling);
    let end = runtime.stop_deadline().map_or(end, |stop| stop.min(end));
    let mut held = Held::default();
    let mut effects = false;
    let result = (|| {
        check(end).map_err(StorageOwnerError::Storage)?;
        held.capture(&original, &config, storage.paths(), &attempt)
            .map_err(StorageOwnerError::Storage)?;
        let mut call = Invocation {
            runtime,
            storage,
            plan,
            admission,
            end,
            attempt,
        };
        call.execute(&mut held, &config, &policy, &mut effects)
    })();
    #[cfg(test)]
    if result.is_ok() && super::faults::take(super::faults::Fault::PrepareClose) {
        native::test_faults::set(None, true);
    }
    finish(result, held.close()).map_err(|error| {
        if effects {
            StorageOwnerError::ColdUnconfirmed(Box::new(error))
        } else {
            error
        }
    })
}

struct Invocation<'a> {
    runtime: &'a WorkerRuntime,
    storage: &'a LaunchStorage,
    plan: &'a ObservedCreatePlan,
    admission: &'a mut Admission,
    end: Instant,
    attempt: NativeOperationId,
}
impl Invocation<'_> {
    fn guard(&mut self, held: &Held, keys: &BTreeSet<Key>) -> OwnerResult<()> {
        held.check(self.end).map_err(StorageOwnerError::Storage)?;
        self.admission
            .observe(self.runtime, self.storage, self.plan, keys, self.end)?;
        held.check(self.end).map_err(StorageOwnerError::Storage)
    }
    fn execute(
        &mut self,
        held: &mut Held,
        config: &Configuration,
        policy: &ColdConfiguration,
        effects: &mut bool,
    ) -> OwnerResult<Ready> {
        let keep = held
            .directory(Slot::Epoch)
            .publish(OsStr::new(".keep"), &retained_keep_record())
            .map_err(StorageOwnerError::Storage)?;
        let original = super::super::super::temporary::path_text(config, self.storage.paths())
            .map_err(StorageOwnerError::Storage)?;
        held.bases = Some(
            Bases::capture(
                policy,
                original.home(),
                &held.directory(Slot::Old).text,
                config.uid(),
            )
            .map_err(StorageOwnerError::Storage)?,
        );
        let reservation = held
            .reserve(original.home(), &self.attempt, self.end)
            .map_err(StorageOwnerError::Storage)?;
        let scope = RetirementPaths::capture(config, self.storage.paths(), policy, self.end)
            .map_err(StorageOwnerError::Storage)?;
        held.bases
            .as_mut()
            .expect("captured bases")
            .barriers(self.end)
            .map_err(StorageOwnerError::Storage)?;
        held.bases
            .as_mut()
            .expect("held barriers")
            .retained_locks(&scope, self.end)
            .map_err(StorageOwnerError::Storage)?;
        let old = held.directory(Slot::Old).stamp().key;
        self.guard(held, &BTreeSet::from([old]))?;
        let before = self.references(held)?;
        held.directory(Slot::Old)
            .check()
            .map_err(StorageOwnerError::Storage)?;
        *effects = true;
        let pending = held
            .directory(Slot::Control)
            .publish(
                OsStr::new(PENDING),
                &retained_intent_record(self.epoch(held), &before, &policy.digest()),
            )
            .map_err(StorageOwnerError::Storage)?;
        held.create_fresh(&self.attempt, config.uid())
            .map_err(StorageOwnerError::Storage)?;
        self.guard(held, &BTreeSet::from([old]))?;
        held.move_roots(&self.attempt, self.end)
            .map_err(StorageOwnerError::Storage)?;
        let new = held.directory(Slot::Fresh).stamp().key;
        self.guard(held, &BTreeSet::from([old, new]))?;
        let after = self.references(held)?;
        let mut ready = Ready {
            attempt: self.attempt.clone(),
            source: self.plan.source().clone(),
            paths: self.storage.paths().clone(),
            old,
            new,
            envelope: held.directory(Slot::Epoch).text.clone(),
            control: held.directory(Slot::Control).stamp().clone(),
            envelope_stamp: held.directory(Slot::Epoch).stamp().clone(),
            identity_stamp: held.directory(Slot::Identity).stamp().clone(),
            keep,
            pending,
            digest: policy.digest(),
            prepared: [0; 32],
            reservation,
            before,
            after,
        };
        let raw = retained_prepared_record(ready.record(), &ready.before, &ready.after);
        held.directory(Slot::Control)
            .publish(&ready.prepared_name(), &raw)
            .map_err(StorageOwnerError::Storage)?;
        ready.prepared = Sha256::digest(&raw).into();
        held.check(self.end).map_err(StorageOwnerError::Storage)?;
        ready.verify(self.end).map_err(StorageOwnerError::Storage)?;
        Ok(ready)
    }
    fn epoch<'a>(&'a self, held: &'a Held) -> RetainedRecordEpoch<'a> {
        RetainedRecordEpoch {
            identity: RetainedRecordIdentity {
                attempt: &self.attempt,
                identity: self.storage.paths().identity(),
                session: self.storage.paths().session(),
                owner: self.storage.paths().owner().as_ref(),
            },
            envelope: &held.directory(Slot::Epoch).text,
            old: held.directory(Slot::Old).stamp().key,
        }
    }
    fn references(&self, held: &Held) -> OwnerResult<ReferenceReport> {
        held.check(self.end).map_err(StorageOwnerError::Storage)?;
        let old = held.directory(Slot::Old);
        let report = references::collect(&old.text, old.file.as_raw_fd(), self.end)
            .map_err(StorageOwnerError::Storage)?;
        held.check(self.end).map_err(StorageOwnerError::Storage)?;
        require(
            report.known_count() == 0,
            "WORKER_COLD_KNOWN_TEMPORARY_REFERENCE",
        )?;
        Ok(report)
    }
}
fn require(ok: bool, code: &'static str) -> OwnerResult<()> {
    if ok {
        Ok(())
    } else {
        Err(StorageOwnerError::Refused(code))
    }
}
pub(super) fn finish<T>(primary: OwnerResult<T>, closed: Result<()>) -> OwnerResult<T> {
    match (primary, closed.map_err(StorageOwnerError::Storage)) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(StorageOwnerError::Finalized {
            primary: Box::new(primary),
            secondary: vec![secondary],
        }),
    }
}
