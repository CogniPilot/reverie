//! Bring the original console back when an apply that stopped it fails.
//!
//! The effects are exactly those of `rollback`: its one journaled attempt, a
//! fresh observation of both containers, the bind and network checks, and a
//! readiness check before the restored receipt. Nothing here restores data,
//! deletes a container or retries a request.
//!
//! The restore is issued only while the candidate has provably never run:
//! the Engine still reports it in its initial `created` state. Once the new
//! console may have written data, returning to the old code is the owner's
//! decision, because the old console may not read what the new one wrote.
//! A lost Engine response also stops here: the container may still be
//! changing, and a second request could race the first.
use super::*;
use crate::error::SourceRestore;

const CANDIDATE_STARTED: &str = "DEPLOYMENT_AUTOMATIC_RESTORE_CANDIDATE_STARTED";
const OUTCOME_UNKNOWN: &str = "DEPLOYMENT_AUTOMATIC_RESTORE_OUTCOME_UNKNOWN";

impl DeploymentService {
    /// Wrap one apply. `stopped_before` is whether the stop was already
    /// journaled when this call began; only the call that journals the stop
    /// restores the console it stopped.
    pub(super) fn restoring_source<T>(
        &self,
        operation: &Operation,
        pins: &crate::pins::Pins,
        stopped_before: bool,
        result: Result<T>,
    ) -> Result<T> {
        match result {
            Err(failure) if !stopped_before && operation.exists("stop-attempt") => {
                Err(self.restore_after_failure(operation, pins, failure))
            }
            other => other,
        }
    }
    fn restore_after_failure(
        &self,
        operation: &Operation,
        pins: &crate::pins::Pins,
        failure: DeploymentError,
    ) -> DeploymentError {
        let admitted = self.restore_admitted(operation, &failure);
        // The decision and its cause are durable before any restore effect.
        let journaled = operation.record(
            "automatic-restore",
            &json!({
                "cause":failure.diagnostic(),
                "decision":if admitted.is_ok() { "ADMITTED" } else { "REFUSED" },
                "refusal":admitted.as_ref().err().map(DeploymentError::diagnostic),
            }),
        );
        let restore = match (admitted, journaled) {
            (Ok(()), Ok(())) => match self.rollback_pinned(operation, pins) {
                Ok(_) => SourceRestore::Restored,
                Err(error) if operation.exists("rollback-attempt") => {
                    SourceRestore::Unproven(error)
                }
                Err(error) => SourceRestore::NotAttempted(error),
            },
            (Err(refusal), Ok(())) => SourceRestore::NotAttempted(refusal),
            (Ok(()), Err(write)) => SourceRestore::NotAttempted(write),
            (Err(refusal), Err(write)) => {
                SourceRestore::NotAttempted(refusal.with_finalizer(write))
            }
        };
        failure.with_source_restore(restore)
    }
    fn restore_admitted(&self, operation: &Operation, failure: &DeploymentError) -> Result<()> {
        require(!failure.outcome_unknown(), OUTCOME_UNKNOWN)?;
        require(
            !operation.record_present("rollback-attempt")?,
            "DEPLOYMENT_ROLLBACK_ALREADY_ATTEMPTED",
        )?;
        require(!operation.record_present("started")?, CANDIDATE_STARTED)?;
        let candidate = self.engine.container(&operation.candidate()?)?;
        require(
            candidate["State"]["Running"] == false && candidate["State"]["Status"] == "created",
            CANDIDATE_STARTED,
        )
    }
}
#[cfg(test)]
mod tests;
