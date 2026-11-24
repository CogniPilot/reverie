use super::*;

impl Operation {
    pub(crate) fn snapshot_diagnostic(&self) -> Result<Option<Value>> {
        if !self.record_present("snapshot-refused")? {
            return Ok(None);
        }
        let raw = read_bounded(&self.directory.join("snapshot-refused.json"), 64 * 1024)?;
        crate::error::decode_receipt(&raw, &self.plan.operation).map(Some)
    }
    pub(crate) fn record_snapshot_refusal(&self, error: DeploymentError) -> DeploymentError {
        let diagnostic = error.diagnostic();
        match self.record("snapshot-refused", &diagnostic) {
            Ok(()) => error,
            Err(write) => error.with_finalizer(write),
        }
    }
    /// The journaled decision to bring the original console back after a
    /// failed apply, with the outcome the later receipts establish.
    pub(crate) fn automatic_restore(&self) -> Result<Option<Value>> {
        if !self.record_present("automatic-restore")? {
            return Ok(None);
        }
        let mut data = self.read_record("automatic-restore")?;
        let outcome = if data["decision"] != "ADMITTED" {
            "NOT_ATTEMPTED"
        } else if self.record_present("restored")? {
            "RESTORED"
        } else if self.record_present("rollback-attempt")? {
            "UNPROVEN"
        } else {
            "NOT_ATTEMPTED"
        };
        data["outcome"] = json!(outcome);
        Ok(Some(data))
    }
}
