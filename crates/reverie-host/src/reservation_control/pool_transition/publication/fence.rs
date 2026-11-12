use super::*;

/// Closed native pool purpose: SAME actual held R and ORIGINAL pending proof.
/// No callback, caller boolean, service-quiescence or reconstructed marker.
pub(crate) struct PoolRenameFence<'a> {
    proof: &'a PendingProof,
    file: &'a PendingFile,
    admission: &'a AdmissionLock,
    end: Instant,
    stop: &'a WorkerStopBudget,
}
impl<'a> PoolRenameFence<'a> {
    pub(super) fn new(
        proof: &'a PendingProof,
        file: &'a PendingFile,
        admission: &'a AdmissionLock,
        stop: &'a WorkerStopBudget,
        end: Instant,
    ) -> Self {
        Self {
            proof,
            file,
            admission,
            end,
            stop,
        }
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        self.assert_deadline()?;
        self.admission
            .assert_current(&self.proof.config, &self.proof.binding)?;
        self.file.assert_current().map_err(pending_error)?;
        self.proof.assert_current()?;
        self.admission
            .assert_current(&self.proof.config, &self.proof.binding)?;
        self.file.assert_current().map_err(pending_error)?;
        self.assert_deadline()
    }
    fn assert_deadline(&self) -> Result<()> {
        let end = self
            .stop
            .deadline()
            .map_or(self.end, |stop| self.end.min(stop));
        need(Instant::now() < end, "POOL_PUBLICATION_DEADLINE")
    }
}
