use super::*;
impl DeploymentService {
    /// Restore only the exact retained old container. This never restores data,
    /// reconfigures the broker, deletes a container or invents a release receipt.
    pub fn rollback(&self, id: &str) -> Result<DeploymentStatus> {
        let operation = self.operation(id)?;
        let pins = self.pins(&operation)?;
        let result = self.rollback_pinned(&operation, &pins);
        DeploymentError::finalized(result, pins.close())
    }
    fn rollback_pinned(
        &self,
        operation: &Operation,
        pins: &crate::pins::Pins,
    ) -> Result<DeploymentStatus> {
        self.claimed(operation)?;
        let source_front = model::uses_front(&operation.plan.source["Config"])?;
        require(
            !operation.exists("rollback-attempt"),
            "DEPLOYMENT_ROLLBACK_ALREADY_ATTEMPTED",
        )?;
        let source_id = model::string(&operation.plan.source, "Id")?;
        let source = self.engine.container(source_id)?;
        require(
            model::projection(&source) == model::projection(&operation.plan.source),
            "DEPLOYMENT_SOURCE_CHANGED",
        )?;
        let candidate = operation.candidate()?;
        let current = self.engine.container(&candidate)?;
        model::candidate_matches(&current, &operation.plan.source, &operation.plan.body)?;
        let original_name = format!("/{}", operation.plan.container);
        let backup_name = format!("/{}", temporary_name(operation, "before-front"));
        let candidate_name = format!("/{}", temporary_name(operation, "candidate"));
        require(
            source["Name"] == original_name || source["Name"] == backup_name,
            "DEPLOYMENT_SOURCE_NAME_CHANGED",
        )?;
        require(
            current["Name"] == original_name || current["Name"] == candidate_name,
            "DEPLOYMENT_CANDIDATE_NAME_CHANGED",
        )?;
        operation.attempt("rollback-attempt")?;
        pins.verify()?;
        if current["State"]["Running"] == true {
            self.engine.stop(&candidate)?;
        }
        let stopped = self.engine.container(&candidate)?;
        require(
            stopped["State"]["Running"] == false && stopped["State"]["Pid"] == 0,
            "DEPLOYMENT_CANDIDATE_STOP_UNCONFIRMED",
        )?;
        if stopped["Name"] == format!("/{}", operation.plan.container) {
            self.engine
                .rename(&candidate, &temporary_name(operation, "failed-front"))?;
        }
        let source = self.engine.container(source_id)?;
        require(
            model::projection(&source) == model::projection(&operation.plan.source)
                && source["State"]["Paused"] == false
                && source["State"]["Restarting"] == false
                && source["State"]["Dead"] == false,
            "DEPLOYMENT_SOURCE_CHANGED",
        )?;
        require(
            source["State"]["Running"] == false && source["State"]["Pid"] == 0
                || source["State"]["Running"] == true
                    && source["State"]["Pid"] == operation.plan.source["State"]["Pid"]
                    && source["State"]["StartedAt"] == operation.plan.source["State"]["StartedAt"],
            "DEPLOYMENT_SOURCE_EPOCH_CHANGED",
        )?;
        pins.verify()?;
        if source["Name"] != format!("/{}", operation.plan.container) {
            require(
                source["Name"] == format!("/{}", temporary_name(operation, "before-front")),
                "DEPLOYMENT_SOURCE_NAME_CHANGED",
            )?;
            self.engine.rename(source_id, &operation.plan.container)?;
        }
        if source["State"]["Running"] == false {
            self.engine.start(source_id)?;
        }
        self.await_ready(source_id, source_front)?;
        let restored = self.engine.container(source_id)?;
        require(
            model::projection(&restored) == model::projection(&operation.plan.source)
                && restored["Name"] == format!("/{}", operation.plan.container),
            "DEPLOYMENT_SOURCE_CHANGED",
        )?;
        pins.running_mounts(&restored)?;
        operation.record(
            "restored",
            &json!({"containerId":source_id,"dataRestored":false,
            "retainedCandidate":candidate,"brokerChanged":false}),
        )?;
        operation.status()
    }
}
