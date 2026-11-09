//! Trusted read-only preparation. This retains a real source lease, not Q
//! approval, a draft claim, capacity credit or permission to wake an employee.
use super::*;
use crate::reservation_observer::{ObservationContext, StoppedRamObservation};
use reverie_contracts::{
    reservation_observation::ClaimEmployee, storage_identity::CurrentEmployee,
};
use reverie_core::ids::ProfileEmployeeId;
use reverie_store::storage_identity::{self, StorageIdentityConfig};
use std::time::Instant;
use storage::{StoppedRamError, StoppedRamSource};
mod error;
mod report;
mod selection;
#[cfg(test)]
mod tests;
use error::{Cause, Result};
pub use error::{StoppedRamAborted, StoppedRamPreparationFailure};
pub use report::StoppedRamReport;
use selection::Selection;

struct Frame<'a> {
    broker: &'a InstallingBroker,
    snapshot: Arc<ValidatedWorkerSnapshot>,
    selection: Selection,
    generation: Option<lifecycle::LaunchGeneration>,
    claim: Option<StorageClaim>,
    context: Option<ObservationContext>,
    source: Option<StoppedRamSource>,
    observed: Option<Arc<StoppedRamObservation>>,
}
#[must_use = "retain source custody or explicitly abort the known unclaimed preparation"]
pub struct EnteredStoppedRamSource<'a> {
    frame: Frame<'a>,
}
impl InstallingBroker {
    /// Resolve the current employee through the installed company registry and
    /// retain its actual lease and stopped/absent observations. No wire route,
    /// journal, profile, intent, configuration or native mutation is performed.
    pub fn prepare_stopped_ram_source(
        &self,
        employee: &ProfileEmployeeId,
    ) -> std::result::Result<EnteredStoppedRamSource<'_>, Box<StoppedRamPreparationFailure<'_>>>
    {
        let snapshot = self.configuration().map_err(error::unowned)?;
        let selection =
            Selection::capture(snapshot.configuration(), employee).map_err(error::unowned)?;
        let name = WorkerContainerName::for_session(
            snapshot.envelope().base(),
            selection.current.session(),
        );
        let admission = self.admit_ordinary_stop(&name).map_err(error::unowned)?;
        let mut frame = Frame {
            broker: self,
            snapshot,
            selection,
            generation: None,
            claim: None,
            context: None,
            source: None,
            observed: None,
        };
        let body = frame.prepare();
        let closed = if body.is_ok() {
            admission.close()
        } else {
            admission.abort()
        };
        match error::finalized(body, closed.map_err(Into::into)) {
            Ok(()) => Ok(EnteredStoppedRamSource { frame }),
            Err(cause) => Err(error::owned(frame, cause)),
        }
    }
}
impl Frame<'_> {
    fn restore(&mut self, end: Instant) -> Result<Option<StorageClaim>> {
        if let Some(source) = self.source.take() {
            match source.restore_unclaimed(end) {
                Ok(restored) => {
                    let (claim, _) = restored.into_parts();
                    self.claim = Some(claim);
                }
                Err(failure) => {
                    let (source, cause) = failure.into_parts();
                    self.source = Some(source);
                    return Err(Cause::Native(cause));
                }
            }
        }
        if let Some(context) = &self.context {
            context.settle_stopped_ram(end).map_err(GateError::from)?;
            self.claim
                .as_ref()
                .expect("original pretransfer claim")
                .assert_stopped_ram_untransferred_custody(context)
                .map_err(Cause::Native)?;
        }
        self.context = None;
        Ok(self.claim.take())
    }
    fn prepare(&mut self) -> Result<()> {
        let life = self.broker.installed.lifecycle()?;
        self.selection.assert_metadata()?;
        selection::check_lifecycle(&life, self.selection.current.session())?;
        self.generation = Some(life.stopped_ram_generation(self.selection.current.session())?);
        self.claim = Some(self.broker.storage.claim(
            self.snapshot.configuration(),
            self.selection.current.session(),
        )?);
        self.context = Some(NativeObserver::capture_worker(
            &self.broker.storage.runtime,
            self.snapshot.configuration().clone(),
        ));
        let claim = self.claim.take().expect("actual acquired claim");
        let context = self.context.take().expect("actual captured context");
        match claim.begin_stopped_ram_source(context) {
            Ok(source) => self.source = Some(source),
            Err(failure) => {
                let (claim, context, cause) = failure.into_parts();
                self.claim = Some(claim);
                self.context = Some(context);
                return Err(Cause::Native(cause));
            }
        }
        let source = self.source.as_mut().expect("actual source transfer");
        self.observed = Some(source.observe().map_err(Cause::Native)?);
        self.selection.assert_metadata()?;
        if !reverie_contracts::worker_config::equivalent(
            source.configuration(),
            self.snapshot.configuration(),
        ) {
            return Err(Cause::Refused("RAM_STOPPED_SOURCE_CONFIGURATION_CHANGED"));
        }
        selection::check_source(&self.selection.current, source)?;
        if !Arc::ptr_eq(&self.snapshot, &self.broker.configuration()?) {
            return Err(Cause::Refused("RAM_STOPPED_INSTALLED_CHANGED"));
        }
        Ok(())
    }
    fn current(&mut self) -> Result<()> {
        let life = self.broker.installed.lifecycle()?;
        life.check_generation(
            self.generation
                .as_ref()
                .expect("captured actual generation"),
        )?;
        selection::check_lifecycle(&life, self.selection.current.session())?;
        if !Arc::ptr_eq(&self.snapshot, &self.broker.configuration()?) {
            return Err(Cause::Refused("RAM_STOPPED_INSTALLED_CHANGED"));
        }
        self.selection.assert_metadata()?;
        let source = self.source.as_mut().expect("actual retained source");
        selection::check_source(&self.selection.current, source)?;
        source.assert_current().map_err(Cause::Native)?;
        self.selection.assert_metadata()
    }
}
impl<'a> EnteredStoppedRamSource<'a> {
    /// This is retained DATA, not a freshness or launch grant. OFF/vacation
    /// disposition remains in the original company row and is never changed.
    pub fn report(&self) -> StoppedRamReport {
        report::capture(&self.frame)
    }
    pub fn assert_current(
        &mut self,
    ) -> std::result::Result<(), Box<StoppedRamPreparationFailure<'_>>> {
        // Failure keeps this owner in place; diagnostics borrow it rather than
        // moving/reconstructing its actual resource owners.
        self.frame.current().map_err(error::unowned)
    }
    /// Restore SAME Direct custody after checked metadata-client settlement.
    /// The returned claim still owns the physical lease; this is not release.
    pub fn abort_unclaimed(
        mut self,
        end: Instant,
    ) -> std::result::Result<StorageClaim, Box<StoppedRamPreparationFailure<'a>>> {
        let source = self.frame.source.take().expect("actual unclaimed source");
        match source.restore_unclaimed(end) {
            Ok(restored) => {
                let (claim, primary) = restored.into_parts();
                match primary {
                    None => Ok(claim),
                    Some(cause) => {
                        self.frame.claim = Some(claim);
                        Err(error::owned(self.frame, Cause::Native(cause)))
                    }
                }
            }
            Err(failure) => {
                let (source, cause) = failure.into_parts();
                self.frame.source = Some(source);
                Err(error::owned(self.frame, Cause::Native(cause)))
            }
        }
    }
}
