//! Only the explicit original live-account disposition may enter this path.
//! It does not pause workers, verify snapshot consistency or restore data.
use super::*;
use std::process::{Child, Command, Stdio};
#[cfg(test)]
mod tests;

impl DeploymentService {
    pub(super) fn apply_live_accounts(
        &self,
        operation: &Operation,
        source: &Value,
        candidate: &str,
        pins: &crate::pins::Pins,
        deadline: OperationDeadline,
        skip_backup: bool,
    ) -> Result<DeploymentStatus> {
        require(
            operation.plan.live_account_writers.is_some(),
            "DEPLOYMENT_OPERATION_WRITERS_INVALID",
        )?;
        pins.running_mounts(source)?;
        self.verify_effect_pins(operation, pins)?;
        let backup = if skip_backup {
            require(
                !operation.exists("retained-copy-attempt"),
                "DEPLOYMENT_RETAINED_COPY_ALREADY_ATTEMPTED",
            )?;
            json!({
                "backupVerified":false,"backupCreated":false,
                "policy":"explicit-owner-live-accounts-skip-backup","sourceDataDeleted":false,
                "codeRollbackGuaranteed":false,"automaticDataRestore":false
            })
        } else {
            self.retain_live_copy(operation, deadline)?
        };
        self.source_current(operation, true)?;
        self.verify_effect_pins(operation, pins)?;
        operation.record("unverified-backup-accepted", &backup)?;
        // Recheck the exact writer observations immediately before stopping the console.
        deadline.check()?;
        self.verify_effect_pins(operation, pins)?;
        operation.attempt("stop-attempt")?;
        deadline.check()?;
        self.engine.stop(model::string(source, "Id")?)?;
        self.source_current(operation, false)?;
        self.verify_effect_pins(operation, pins)?;
        self.swap_scoped(operation, candidate, pins, deadline)?;
        operation.status()
    }

    fn retain_live_copy(
        &self,
        operation: &Operation,
        deadline: OperationDeadline,
    ) -> Result<Value> {
        let destination = operation.directory.join("retained-copy");
        require(!destination.try_exists()?, "DEPLOYMENT_COPY_OCCUPIED")?;
        let copy = option_env!("REVERIE_DEPLOYMENT_COPY")
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_COPY_UNINSTALLED"))?;
        let console = self.data_source(operation)?.join("console");
        operation.attempt("retained-copy-attempt")?;
        let child = Command::new(copy)
            .args(["--archive", "--reflink=auto", "--no-target-directory", "--"])
            .arg(console)
            .arg(&destination)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        join_copy(child, deadline.snapshot())?;
        Ok(json!({
                "backupVerified":false,"copy":destination,"copyExitSuccess":true,
                "policy":"explicit-owner-live-accounts-fix-forward","sourceDataDeleted":false,
                "codeRollbackGuaranteed":false,"automaticDataRestore":false
        }))
    }
}

fn join_copy(mut child: Child, end: Instant) -> Result<()> {
    loop {
        if let Some(status) = child.try_wait()? {
            return require(status.success(), "DEPLOYMENT_RETAINED_COPY_UNCONFIRMED");
        }
        if Instant::now() >= end {
            let killed = child.kill().map_err(DeploymentError::from);
            let joined = child.wait().map(|_| ()).map_err(DeploymentError::from);
            return DeploymentError::finalized(
                Err(DeploymentError::new("DEPLOYMENT_RETAINED_COPY_DEADLINE")),
                DeploymentError::finalized(killed, joined),
            );
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
