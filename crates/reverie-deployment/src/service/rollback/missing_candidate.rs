//! Observation-only closure after external deletion of an untouched candidate.
//! Absence is an authenticated complete Engine 404, never an error inference.
use super::*;

fn untouched(operation: &Operation) -> Result<()> {
    operation.prepared()?;
    for marker in [
        "stop-attempt",
        "snapshot",
        "old-rename-attempt",
        "old-renamed",
        "new-rename-attempt",
        "new-renamed",
        "start-attempt",
        "started",
        "ready",
        "rollback-attempt",
        "restored",
    ] {
        require(
            !operation.record_present(marker)?,
            "DEPLOYMENT_MISSING_CANDIDATE_LIFECYCLE_UNCONFIRMED",
        )?;
    }
    Ok(())
}
impl DeploymentService {
    pub(super) fn rollback_missing_candidate(
        &self,
        operation: &Operation,
        pins: &crate::pins::Pins,
        candidate: &str,
    ) -> Result<DeploymentStatus> {
        untouched(operation)?;
        let source = self.source_current(operation, true)?;
        let birth = super::super::adoption::birth(&source)?;
        self.missing_candidate_current(operation, pins, candidate, &birth)?;
        untouched(operation)?;
        // This one-attempt marker records only metadata observation, and also
        // preserves the existing terminal-claim handover protocol. A lost ACK
        // remains held; this path never dispatches STOP/START/rename or CREATE.
        operation.record(
            "rollback-attempt",
            &json!({"state":"OBSERVATION_ONLY_NO_NATIVE_EFFECTS", "missingCandidate":candidate}),
        )?;
        self.missing_candidate_current(operation, pins, candidate, &birth)?;
        operation.record(
            "restored",
            &json!({"containerId":operation.plan.source["Id"],
            "dataRestored":false,"missingCandidate":candidate,"brokerChanged":false}),
        )?;
        operation.status()
    }
    fn missing_candidate_current(
        &self,
        operation: &Operation,
        pins: &crate::pins::Pins,
        candidate: &str,
        birth: &str,
    ) -> Result<()> {
        self.claimed(operation)?;
        let source = self.source_current(operation, true)?;
        require(
            source["Name"] == format!("/{}", operation.plan.container)
                && super::super::adoption::birth(&source)? == birth,
            "DEPLOYMENT_SOURCE_EPOCH_CHANGED",
        )?;
        model::port_binding(&source, self.installation.port)?;
        pins.running_mounts(&source)?;
        let source_id = model::string(&source, "Id")?;
        self.process_tree(source_id, model::uses_front(&source["Config"])?)?;
        require(
            apply::status_responds_scoped(self.installation.port, OperationDeadline::Ordinary),
            "DEPLOYMENT_READINESS_UNCONFIRMED",
        )?;
        self.verify_effect_pins(operation, pins)?;
        self.engine.require_absent_container(candidate)?;
        let after = self.source_current(operation, true)?;
        require(
            after["Name"] == source["Name"] && super::super::adoption::birth(&after)? == birth,
            "DEPLOYMENT_SOURCE_EPOCH_CHANGED",
        )?;
        pins.running_mounts(&after)?;
        self.claimed(operation)
    }
}
