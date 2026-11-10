//! Clear only the selected manager's failed condition after original unknown
//! records are archived under the denying upgrade attempt. No runtime outcome
//! or controller cleanup is acknowledged by a manager reset.
use super::*;

impl State {
    pub(super) fn reset_failed_upgrade(
        &mut self,
        old: &Path,
        expected: &ExpectedCommands,
        group: &ServiceGroupData,
    ) -> Result<()> {
        self.assert_upgrade_stopped(old, expected, true)?;
        self.assert_force_group_current(group)?;
        self.assert_no_native_actor()?;
        let before = self.observe()?;
        self.reset_failed_manager(&before)?;
        self.assert_upgrade_stopped(old, expected, false)?;
        self.assert_force_group_current(group)?;
        self.assert_no_native_actor()
    }
    /// The manager command is one bounded effect; this helper establishes only
    /// manager state. Its caller owns and revalidates native quiescence.
    pub(in crate::worker_service) fn reset_failed_manager(
        &mut self,
        before: &ObservedUnit,
    ) -> Result<()> {
        before.require_action_finished(&WorkerServiceAction::Upgrade {
            force_stopped: true,
        })?;
        if before.active == "failed" {
            self.command(&["reset-failed", UNIT])?;
        }
        let after = self.observe()?;
        need(
            after.fragment == before.fragment,
            "NATIVE_SERVICE_GENERATION_CHANGED_DURING_COMMAND",
        )?;
        after.require_action_finished(&WorkerServiceAction::Stop)
    }
}
