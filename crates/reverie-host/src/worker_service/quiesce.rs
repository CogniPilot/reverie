//! Opt-in maintained laptop/service handoff. C acknowledgement is DATA only;
//! the SAME service owner still requires its actual unit-stop completion.
use super::*;
use reverie_contracts::worker_schema::{WorkerEnvelope, WorkerPath};
impl State {
    pub(super) fn verify_deployment_stopped(&mut self) -> Result<()> {
        self.upgrade_bus = Some(stopped::bus::BusReader::capture(self)?);
        let group = self
            .upgrade_bus
            .as_mut()
            .expect("retained actual bus reader")
            .stopped_group()?;
        // Reuse the fixed PID/job/cgroup reader; this issues no force, archive,
        // marker removal or new process operation.
        self.assert_force_group_current(&group)?;
        self.assert_no_native_actor()?;
        Ok(())
    }
    pub(super) fn quiesce_for_deployment(&mut self) -> Result<()> {
        if let Some(cause) = &self.quiescence_failure {
            return Err(WorkerServiceError::Control(Arc::clone(cause)));
        }
        let before = self.source_snapshot()?;
        let config = reverie_contracts::worker_config::decode_owner_text(before.raw.as_bytes())
            .map_err(WorkerServiceError::Configuration)?;
        let envelope = WorkerEnvelope::capture(config).map_err(WorkerServiceError::Schema)?;
        let endpoint = native::python_path(&envelope.path(WorkerPath::Socket).codepoints())?;
        // This State already owns its exclusive original STOP pending. No
        // supported concurrent start/upgrade may pass it while C drains.
        let reply = reverie_worker_client::control::call(
            &endpoint,
            reverie_worker_client::control::Action::QuiesceForDeployment,
            self.end,
        );
        if let Err(error) = reply {
            let cause = Arc::clone(
                self.quiescence_failure
                    .get_or_insert_with(|| Arc::new(error)),
            );
            return Err(WorkerServiceError::Control(cause));
        }
        let after = self.source_snapshot()?;
        need(
            before.raw == after.raw,
            "NATIVE_SERVICE_QUIESCE_SOURCE_CHANGED",
        )
    }
}
/// Whole original owner on either phase's failure. No failed ACK is resent and
/// no stopped-service owner is reconstructed from reply JSON.
#[derive(Debug)]
pub enum DeploymentServiceQuiesceFailure {
    Stop(Box<WorkerServiceFailure>),
    Maintenance(Box<StoppedServiceFailure>),
}
impl DeploymentServiceQuiesceFailure {
    /// Original component settlement only: no C resend, unit stop replay,
    /// pending removal, maintenance release or deployment acknowledgement.
    pub fn close_components(&mut self) -> Result<()> {
        match self {
            Self::Stop(owner) => owner.close_components(),
            Self::Maintenance(owner) => owner.close_components(),
        }
    }
}
impl std::fmt::Display for DeploymentServiceQuiesceFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stop(e) => e.fmt(out),
            Self::Maintenance(e) => e.fmt(out),
        }
    }
}
impl std::error::Error for DeploymentServiceQuiesceFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Stop(e) => Some(e.as_ref()),
            Self::Maintenance(e) => Some(e.as_ref()),
        }
    }
}
/// Returned ORIGINAL image-maintenance owner must remain retained through the
/// deployment's full fresh writer census and all effects/checked finalizers.
/// A concurrent supported start during the handoff makes capture refuse.
pub fn quiesce_stopped_worker_service(
    source: &Path,
    role: NativeWorkerServiceRole,
    end: Instant,
) -> std::result::Result<ImageServiceMaintenance, DeploymentServiceQuiesceFailure> {
    run_native_worker_service_for_role(source, WorkerServiceAction::QuiesceStop, role, end)
        .map_err(DeploymentServiceQuiesceFailure::Stop)?;
    stopped::capture_deployment_maintenance(source, end, role)
        .map_err(DeploymentServiceQuiesceFailure::Maintenance)?
        .begin_image_transition()
        .map_err(DeploymentServiceQuiesceFailure::Maintenance)
}
