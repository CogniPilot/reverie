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
}
