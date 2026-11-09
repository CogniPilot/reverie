//! One-shot successor of a verified terminal claim under the original update lock.
use super::*;
mod file;
use file::ClaimFile;
#[cfg(test)]
mod tests;

pub(super) struct PreparedClaim<'a> {
    installation: &'a Installation,
    active: ClaimFile,
    successor: Option<Box<Successor>>,
}
struct Successor {
    previous: Operation,
    terminal: &'static str,
    pending: ClaimFile,
    archived: ClaimFile,
    replacement: ClaimFile,
    next: String,
}
impl PreparedClaim<'_> {
    pub(super) fn finish(self, operation: &Operation, current: &Value) -> Result<()> {
        let installation = self.installation;
        installation.current()?;
        assert_source(installation, operation, current)?;
        self.active.assert_current()?;
        let Some(successor) = self.successor else {
            return require(
                self.active.selected()? == operation.plan.operation,
                "DEPLOYMENT_OTHER_OPERATION_ACTIVE",
            );
        };
        require(
            successor.next == operation.plan.operation,
            "DEPLOYMENT_OTHER_OPERATION_ACTIVE",
        )?;
        successor.pending.assert_current()?;
        successor.archived.assert_current()?;
        successor
            .previous
            .assert_claim_source(successor.terminal, current)?;
        successor.replacement.assert_current()?;
        installation.current()?;
        successor.pending.assert_current()?;
        self.active.assert_current()?;
        // All temporary-file writes, syncs and real source observation precede
        // this adjacent original-claim identity check and atomic replacement.
        std::fs::rename(&successor.replacement.path, &self.active.path)?;
        let destination_synced = installation::sync_directory(&installation.state);
        let source_synced = installation::sync_directory(&operation.directory);
        DeploymentError::finalized(destination_synced, source_synced)?;
        successor.replacement.assert_renamed(&self.active.path)?;
        operation.record(
            "claim-acquired",
            &json!({"operation":operation.plan.operation,
            "predecessor":successor.previous.plan.operation}),
        )?;
        successor.previous.record(
            "superseded",
            &json!({"successor":operation.plan.operation,
            "claimDigest":installation::digest(&self.active.bytes)}),
        )
    }
}
impl DeploymentService {
    pub(super) fn claim(
        &self,
        operation: &Operation,
        current: &Value,
    ) -> Result<PreparedClaim<'_>> {
        self.installation.current()?;
        assert_source(&self.installation, operation, current)?;
        let path = self
            .installation
            .state
            .join("console-deployment-active.json");
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let bytes = serde_json::to_vec(&json!({"operation":operation.plan.operation}))?;
                installation::exclusive_bytes(&path, &bytes)?;
                Ok(PreparedClaim {
                    installation: &self.installation,
                    active: ClaimFile::capture_written(path, &bytes)?,
                    successor: None,
                })
            }
            Err(error) => Err(error.into()),
            Ok(_) => self.prepare_successor(operation, current, ClaimFile::capture(path)?),
        }
    }
    fn prepare_successor(
        &self,
        operation: &Operation,
        current: &Value,
        active: ClaimFile,
    ) -> Result<PreparedClaim<'_>> {
        require(
            !operation.record_present("claim-attempt")?,
            "DEPLOYMENT_CLAIM_HANDOVER_ALREADY_ATTEMPTED",
        )?;
        let previous = self.operation(&active.selected()?)?;
        let terminal = previous.claim_terminal(current)?;
        let attempt = json!({"successor":operation.plan.operation,"claimDigest":installation::digest(&active.bytes)});
        // The active predecessor is latched BEFORE any archive/replacement work.
        // An uncertain outcome never becomes a replayable completed claim.
        let pending_bytes = previous.record_written("successor-attempt", &attempt)?;
        operation.record(
            "claim-attempt",
            &json!({"predecessor":previous.plan.operation,
            "terminal":terminal,"claimDigest":installation::digest(&active.bytes)}),
        )?;
        let pending = ClaimFile::capture_written(
            previous.directory.join("successor-attempt.json"),
            &pending_bytes,
        )?;
        let archive = operation.directory.join("claim-before.json");
        installation::exclusive_bytes(&archive, &active.bytes)?;
        let archived = ClaimFile::capture_written(archive, &active.bytes)?;
        let replacement = operation.directory.join("claim-next.json");
        let replacement_bytes = serde_json::to_vec(&json!({"operation":operation.plan.operation}))?;
        installation::exclusive_bytes(&replacement, &replacement_bytes)?;
        let replacement = ClaimFile::capture_written(replacement, &replacement_bytes)?;
        Ok(PreparedClaim {
            installation: &self.installation,
            active,
            successor: Some(Box::new(Successor {
                previous,
                terminal,
                pending,
                archived,
                replacement,
                next: operation.plan.operation.clone(),
            })),
        })
    }
}
fn assert_source(
    installation: &Installation,
    operation: &Operation,
    current: &Value,
) -> Result<()> {
    let selected = &operation.plan.source;
    require(
        operation.plan.container == installation.name
            && operation.plan.installation_revision == installation.revision
            && model::projection(current) == model::projection(selected)
            && current["Name"] == format!("/{}", installation.name)
            && current["State"]["Running"] == true
            && current["State"]["Paused"] == false
            && current["State"]["Restarting"] == false
            && current["State"]["Dead"] == false
            && current["State"]["Pid"].as_u64().is_some_and(|pid| pid > 0)
            && current["State"]["Pid"] == selected["State"]["Pid"]
            && current["State"]["StartedAt"] == selected["State"]["StartedAt"],
        "DEPLOYMENT_SOURCE_CHANGED",
    )
}
