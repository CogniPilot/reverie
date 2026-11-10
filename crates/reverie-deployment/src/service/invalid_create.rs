//! Explicit retirement of the single historical invalid PID-mode constructor.
//! Docker 29.6.1 validates PidMode before daemon.create (no name/layer/mount).
use super::*;
mod inventory;
impl DeploymentService {
    pub(super) fn effect_operation(&self, id: &str) -> Result<Operation> {
        let operation = self.operation(id)?;
        require(
            operation.plan.version == operation.plan.profile().version(),
            "DEPLOYMENT_LEGACY_PLAN_READ_ONLY",
        )?;
        Ok(operation)
    }
    /// Preserve a rejected v2 plan and its attempt; never reissue its create.
    /// Absence corroborates the exact invalid-request proof, not a timeout.
    pub fn recover_invalid_create(&self, id: &str) -> Result<DeploymentStatus> {
        let operation = self.operation(id)?;
        operation.assert_invalid_create_prefix()?;
        for name in ["invalid-create-refused", "successor-attempt", "superseded"] {
            require(
                !operation.record_present(name)?,
                "DEPLOYMENT_INVALID_CREATE_RECOVERY_ALREADY_ATTEMPTED",
            )?;
        }
        self.claimed(&operation)?;
        let source = self.source_current(&operation, true)?;
        let (mut historical, _) = self.profile_body(
            &source,
            &operation.plan.preview.candidate_image,
            model::DeploymentProfile::ProtectedWebsite,
        )?;
        historical["HostConfig"]["PidMode"] = json!("private");
        require(
            historical == operation.plan.body,
            "DEPLOYMENT_NOT_LEGACY_INVALID_CREATE",
        )?;
        let pins = self.pins(&operation)?;
        let result = self.recover_invalid_create_pinned(&operation, &source, &pins);
        DeploymentError::finalized(result, pins.close())
    }
    fn recover_invalid_create_pinned(
        &self,
        operation: &Operation,
        source: &Value,
        pins: &crate::pins::Pins,
    ) -> Result<DeploymentStatus> {
        pins.running_mounts(source)?;
        let daemon = self.invalid_create_daemon()?;
        let rows = self.engine.json("GET", "/containers/json?all=1", None)?;
        let count = inventory::assert_absent(operation, &rows)?;
        let receipt = json!({"proof":crate::operation::INVALID_CREATE_PROOF,
            "requestSHA256":installation::digest(&serde_json::to_vec(&operation.plan.body)?),
            "sourceSHA256":installation::digest(&serde_json::to_vec(&model::projection(source))?),
            "sourcePid":source["State"]["Pid"],"sourceStartedAt":source["State"]["StartedAt"],
            "sourceName":source["Name"],"candidateName":operation.invalid_create_name(),
            "daemon":daemon,"inventory":{"rows":count,"sha256":installation::digest(&serde_json::to_vec(&rows)?)}});
        require(
            self.invalid_create_daemon()? == daemon,
            "DEPLOYMENT_INVALID_CREATE_DAEMON_CHANGED",
        )?;
        self.claimed(operation)?;
        operation.assert_invalid_create_prefix()?;
        let current = self.source_current(operation, true)?;
        pins.running_mounts(&current)?;
        pins.verify()?;
        self.installation.current()?;
        operation.record("invalid-create-refused", &receipt)?;
        operation.assert_invalid_create_refused(&current)?;
        operation.status()
    }
    fn invalid_create_daemon(&self) -> Result<Value> {
        let version = self.engine.json("GET", "/version", None)?;
        require(
            version["Version"] == "29.6.1" && version["Os"] == "linux",
            "DEPLOYMENT_INVALID_CREATE_DAEMON_UNSUPPORTED",
        )?;
        let info = self.engine.json("GET", "/info", None)?;
        let id = model::string(&info, "ID")?;
        require(
            !id.is_empty() && id.len() <= 128,
            "DEPLOYMENT_INVALID_CREATE_DAEMON_UNCONFIRMED",
        )?;
        Ok(json!({"version":version["Version"],"os":version["Os"],"id":id}))
    }
}
