//! Historical invalid request evidence, never a generic unknown-create waiver.
use super::*;
pub(crate) const PROOF: &str = "moby-linux-29.6.1-private-pid-rejected-before-create-v1";
impl Operation {
    pub(crate) fn assert_invalid_create_refused(&self, current: &Value) -> Result<()> {
        self.assert_invalid_create_prefix()?;
        let receipt = self.read_record("invalid-create-refused")?;
        require(
            receipt.as_object().is_some_and(|fields| fields.len() == 9)
                && receipt["proof"] == PROOF
                && receipt["requestSHA256"]
                    == installation::digest(&serde_json::to_vec(&self.plan.body)?)
                && receipt["sourceSHA256"]
                    == installation::digest(&serde_json::to_vec(&model::projection(current))?)
                && model::projection(current) == model::projection(&self.plan.source)
                && receipt["sourcePid"] == self.plan.source["State"]["Pid"]
                && receipt["sourceStartedAt"] == self.plan.source["State"]["StartedAt"]
                && receipt["sourceName"] == self.plan.source["Name"]
                && current["State"]["Running"] == true
                && current["State"]["Paused"] == false
                && current["State"]["Restarting"] == false
                && current["State"]["Dead"] == false
                && current["State"]["Pid"].as_u64().is_some_and(|pid| pid > 0)
                && current["State"]["Pid"] == receipt["sourcePid"]
                && current["State"]["StartedAt"] == receipt["sourceStartedAt"]
                && current["Name"] == format!("/{}", self.plan.container)
                && receipt["candidateName"] == self.invalid_create_name()
                && receipt["daemon"]["version"] == "29.6.1"
                && receipt["daemon"]["os"] == "linux"
                && receipt["daemon"]["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && id.len() <= 128)
                && receipt["inventory"]["rows"]
                    .as_u64()
                    .is_some_and(|n| n > 0 && n <= 4096)
                && receipt["inventory"]["sha256"]
                    .as_str()
                    .is_some_and(valid_digest),
            "DEPLOYMENT_INVALID_CREATE_RECEIPT_UNCONFIRMED",
        )
    }
    pub(crate) fn assert_invalid_create_prefix(&self) -> Result<()> {
        require(
            self.plan.version == 2
                && self.plan.profile() == model::DeploymentProfile::ProtectedWebsite,
            "DEPLOYMENT_NOT_LEGACY_INVALID_CREATE",
        )?;
        model::validate_legacy_invalid_body(&self.plan.source, &self.plan.body)?;
        require(
            self.read_record("create-attempt")?["state"] == "ATTEMPT_NO_AUTOMATIC_RETRY",
            "DEPLOYMENT_INVALID_CREATE_ATTEMPT_REQUIRED",
        )?;
        for name in [
            "candidate",
            "prepared",
            "stop-attempt",
            "snapshot",
            "snapshot-refused",
            "old-rename-attempt",
            "old-renamed",
            "new-rename-attempt",
            "new-renamed",
            "start-attempt",
            "started",
            "ready",
            "rollback-attempt",
            "restored",
            "unverified-backup-accepted",
            "retained-copy",
            "retained-copy-attempt",
        ] {
            require(
                !self.record_present(name)?,
                "DEPLOYMENT_INVALID_CREATE_EFFECT_PRESENT",
            )?;
        }
        Ok(())
    }
    pub(crate) fn invalid_create_name(&self) -> String {
        crate::service::temporary_name(self, "candidate")
    }
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
