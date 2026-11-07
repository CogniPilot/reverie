//! Original pre-unlock rootless inspection on the SAME retained Nix resources.
//! This is not a new image registry, launch grant or resource reconstruction.
use super::*;
use reverie_contracts::rootless::{RootlessConfig, RootlessImage};

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum ImagePhase {
    Unchecked,
    Attempted,
    Confirmed,
    Absent,
}
/// Observation of this actual record's pre-Nix phase, not an effect permit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NixImageQualification {
    NotRequired,
    Confirmed,
    Rejected,
    Retained,
}
pub(super) trait Observations {
    fn enabled(&self, config: &RootlessConfig) -> Result<bool>;
    fn image(&self, config: &RootlessConfig, image: &RootlessImage) -> Result<()>;
}
struct Installed;
impl Observations for Installed {
    fn enabled(&self, config: &RootlessConfig) -> Result<bool> {
        Ok(crate::rootless::observe_rootless(config)?.enabled())
    }
    fn image(&self, config: &RootlessConfig, image: &RootlessImage) -> Result<()> {
        crate::rootless::require_rootless_image(config, image)?;
        Ok(())
    }
}
fn configuration(record: &Record) -> Result<RootlessConfig> {
    RootlessConfig::capture(record.prepared.clone())
        .map_err(crate::rootless::RootlessHostError::from)
        .map_err(Into::into)
}
pub(super) fn require_qualified(record: &Record) -> Result<()> {
    need(
        !configuration(record)?.enabled() || record.image == ImagePhase::Confirmed,
        NixFault::ImageQualification,
    )
}
impl Workflows {
    pub(super) fn qualify_image(
        &self,
        runtime: &WorkerRuntime,
        workflow: &NixWorkflow,
        deadline: Instant,
        observed: &impl Observations,
    ) -> Result<NixImageQualification> {
        self.bound(runtime, workflow)?;
        let mut record = workflow
            .record
            .try_lock()
            .map_err(|_| NixError::Refused(NixFault::Retained))?;
        need(
            record.phase == Phase::Held && record.image == ImagePhase::Unchecked,
            NixFault::ImageQualification,
        )?;
        // The installing caller still holds its original lifecycle guard.
        // Retain the actual phase before profile reads or a client constructor.
        record.image = ImagePhase::Attempted;
        record.phase = Phase::Running;
        match inspect(runtime, &mut record, deadline, observed) {
            Ok(enabled) => {
                record.image = if enabled {
                    ImagePhase::Confirmed
                } else {
                    ImagePhase::Absent
                };
                record.phase = Phase::Held;
                Ok(if enabled {
                    NixImageQualification::Confirmed
                } else {
                    NixImageQualification::NotRequired
                })
            }
            Err(error) => {
                record.outcome = Some(Err(error));
                cleanup::finish(runtime, self, &mut record, Some(deadline));
                Ok(if record.phase == Phase::Known {
                    NixImageQualification::Rejected
                } else {
                    NixImageQualification::Retained
                })
            }
        }
    }
}
fn running(runtime: &WorkerRuntime, supplied: Instant) -> Result<()> {
    let end = runtime
        .stop_deadline()
        .map_or(supplied, |stop| supplied.min(stop));
    need(Instant::now() < end, NixFault::Deadline)?;
    need(!runtime.cancellation().is_cancelled(), NixFault::Cancelled)
}
fn inspect(
    runtime: &WorkerRuntime,
    record: &mut Record,
    deadline: Instant,
    observed: &impl Observations,
) -> Result<bool> {
    running(runtime, deadline)?;
    let config = configuration(record)?;
    if !observed.enabled(&config)? {
        // Original disabled branch performs no engine or fresh resource reads.
        return Ok(false);
    }
    record.resources().guard.assert_current()?;
    record.resources().storage.check_resource_current()?;
    let selected = NixConfiguration::capture(&record.prepared).image()?;
    running(runtime, deadline)?;
    let output = drive::call(
        runtime,
        record,
        drive::Query::Image(&selected),
        Some(deadline),
    )?;
    need(output.succeeded, NixFault::EngineFailed)?;
    let image = RootlessImage::decode_inspection(&output.stdout, &selected)
        .map_err(crate::rootless::RootlessHostError::from)?;
    // Preserve the original SECOND profile/host qualification after inspect,
    // and before releasing the application lifecycle lock for Nix work.
    observed.image(&config, &image)?;
    record.resources().guard.assert_current()?;
    record.resources().storage.check_resource_current()?;
    running(runtime, deadline)?;
    Ok(true)
}
impl WorkerRuntime {
    /// Fixed actual pre-unlock observation; no caller image, argv or callback.
    /// The returned enum cannot mint or replace this record's private phase.
    pub fn qualify_prepared_nix_image(
        &self,
        workflow: &NixWorkflow,
        deadline: Instant,
    ) -> Result<NixImageQualification> {
        self.nix_workflows()
            .qualify_image(self, workflow, deadline, &Installed)
    }
}
