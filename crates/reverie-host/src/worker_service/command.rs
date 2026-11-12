//! Fixed start/stop actions over the existing retained manager owner.
use super::*;
impl State {
    pub(super) fn run_service_command(
        &mut self,
        action: &WorkerServiceAction,
        observed: ObservedUnit,
    ) -> Result<()> {
        let verb = match action {
            WorkerServiceAction::Start => {
                self.assert_installed(&observed)?;
                "start"
            }
            WorkerServiceAction::QuiesceStop => {
                self.assert_installed(&observed)?;
                "stop"
            }
            WorkerServiceAction::Stop => {
                self.assert_stoppable(&observed)?;
                "stop"
            }
            _ => {
                return Err(WorkerServiceError::Refused(
                    "NATIVE_SERVICE_COMMAND_PURPOSE",
                ));
            }
        };
        self.begin_attempt(action)?;
        self.attempted = true;
        let quiescence = if matches!(action, WorkerServiceAction::QuiesceStop) {
            self.quiesce_for_deployment()
        } else {
            Ok(())
        };
        // A lost C reply is not a retry permit. Complete the distinct already
        // authorized unit-stop attempt once, preserving both original results.
        let command = self.finish_service_command(action, &observed, verb);
        finalized(quiescence, command)
    }
    fn finish_service_command(
        &mut self,
        action: &WorkerServiceAction,
        observed: &ObservedUnit,
        verb: &str,
    ) -> Result<()> {
        self.command(&[verb, UNIT])?;
        let current = self.observe()?;
        need(
            current.fragment == observed.fragment,
            "NATIVE_SERVICE_GENERATION_CHANGED_DURING_COMMAND",
        )?;
        match action {
            WorkerServiceAction::Start | WorkerServiceAction::QuiesceStop => {
                self.assert_installed(&current)?
            }
            _ => self.assert_stoppable(&current)?,
        }
        current.require_action_finished(action)?;
        if matches!(action, WorkerServiceAction::QuiesceStop) {
            self.verify_deployment_stopped()?;
            let after = self.observe()?;
            need(
                after.fragment == observed.fragment,
                "NATIVE_SERVICE_GENERATION_CHANGED_DURING_COMMAND",
            )?;
            after.require_action_finished(action)?;
        }
        Ok(())
    }
}
