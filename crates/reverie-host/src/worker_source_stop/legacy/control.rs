//! Fixed C stop purpose. No launch request or create plan is fabricated.
use super::*;
use reverie_contracts::{worker_config::EffectiveWorkerConfig, worker_recovery::RecoveryNames};
use reverie_core::worker_schema::{WorkerBase, WorkerServiceIdentity};

#[must_use = "retain the exact native census ticket on uncertainty"]
pub struct ControlStopCensus {
    origin: Arc<InstalledWorkerEngine>,
    base: WorkerBase,
    end: Instant,
    pending: Option<CapturedCall>,
}
impl WorkerRuntime {
    pub fn control_stop_census(
        &self,
        base: &WorkerBase,
        end: Instant,
    ) -> Result<ControlStopCensus> {
        need(
            WorkerServiceIdentity::capture(base) == *self.worker_identity(),
            "WORKER_CONTROL_STOP_ORIGIN",
        )?;
        Ok(ControlStopCensus {
            origin: self.installed_engine().clone(),
            base: base.clone(),
            end,
            pending: None,
        })
    }
    /// Pure transfer of the actual held resource, before the stop effect.
    pub fn retain_control_laptop_stop(
        &self,
        storage: Box<LaunchStorage>,
        source: &EffectiveWorkerConfig,
        end: Instant,
    ) -> std::result::Result<ControlLaptopStop, Box<(Box<LaunchStorage>, SourceStopError)>> {
        let checked = storage
            .assert_binding(self, source, storage.paths().session())
            .map_err(SourceStopError::Resource)
            .and_then(|()| {
                storage
                    .check_resource_current()
                    .map(|_| ())
                    .map_err(SourceStopError::Resource)
            });
        if let Err(cause) = checked {
            return Err(Box::new((storage, cause)));
        }
        let session = storage.paths().session().clone();
        let name = format!(
            "{}-agent-{}",
            self.worker_identity().deployment(),
            session.as_str()
        );
        Ok(ControlLaptopStop {
            attempt: OrdinaryStopAttempt {
                origin: self.installed_engine().clone(),
                phase: LegacyPhase::Held,
                name,
                session,
                container: None,
                deadline: Some(end),
                pending: None,
                failure: None,
            },
            storage: Some(storage),
            source: source.clone(),
        })
    }
}
impl ControlStopCensus {
    pub fn read(&mut self, runtime: &WorkerRuntime) -> Result<RecoveryNames> {
        need(
            Arc::ptr_eq(&self.origin, runtime.installed_engine()) && self.pending.is_none(),
            "WORKER_CONTROL_STOP_ORIGIN",
        )?;
        let output = call::captured(
            &self.origin,
            self.end,
            &mut self.pending,
            vec![
                "ps".into(),
                "--filter".into(),
                format!("label=reverie.worker={}", self.base.deployment()).into(),
                "--format".into(),
                "{{.Names}}".into(),
            ],
            true,
        )?;
        let raw = std::str::from_utf8(&output.stdout)
            .map_err(|_| SourceStopError::Refused("WORKER_CONTROL_STOP_CENSUS"))?;
        let names = RecoveryNames::decode_complete_stop(&self.base, raw)
            .map_err(|_| SourceStopError::Refused("WORKER_CONTROL_STOP_CENSUS"))?;
        Ok(names)
    }
    pub fn settle(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        need(
            Arc::ptr_eq(&self.origin, runtime.installed_engine()),
            "WORKER_CONTROL_STOP_ORIGIN",
        )?;
        if let Some(call) = &self.pending {
            self.origin
                .engine
                .client
                .settle_call(
                    call,
                    self.origin
                        .stop_deadline()
                        .map_or(end, |stop| end.min(stop)),
                )
                .map_err(|error| SourceStopError::Engine(error.into()))?;
            self.pending = None;
        }
        Ok(())
    }
}
impl Drop for ControlStopCensus {
    fn drop(&mut self) {
        if let Some(call) = self.pending.take() {
            std::mem::forget((self.origin.clone(), call));
        }
    }
}
#[must_use = "retain the same actual Box and native stop on uncertainty"]
pub struct ControlLaptopStop {
    attempt: OrdinaryStopAttempt,
    storage: Option<Box<LaunchStorage>>,
    source: EffectiveWorkerConfig,
}
impl ControlLaptopStop {
    pub(crate) fn bind_created_identity(&mut self, id: reverie_core::ids::ContainerId) {
        self.attempt.container = Some(id);
    }
    pub fn stop_after_admission(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        let storage = self
            .storage
            .as_ref()
            .ok_or(SourceStopError::Refused("WORKER_CONTROL_STOP_CONSUMED"))?;
        storage
            .assert_binding(runtime, &self.source, storage.paths().session())
            .map_err(SourceStopError::Resource)?;
        self.attempt.run(runtime)
    }
    pub fn settle_native(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        self.attempt.settle(runtime, end)
    }
    pub fn take_stopped_storage(
        &mut self,
        runtime: &WorkerRuntime,
        end: Instant,
    ) -> Result<Box<LaunchStorage>> {
        self.attempt.bound(runtime)?;
        need(self.attempt.confirmed(), "WORKER_CONTROL_STOP_UNCONFIRMED")?;
        self.attempt.settle(runtime, end)?;
        self.storage
            .take()
            .ok_or(SourceStopError::Refused("WORKER_CONTROL_STOP_CONSUMED"))
    }
}
impl Drop for ControlLaptopStop {
    fn drop(&mut self) {
        if let Some(storage) = self.storage.take() {
            quarantine(
                self.attempt.origin.clone(),
                storage,
                self.attempt.pending.take(),
                self.attempt.failure.take(),
            );
        }
    }
}
