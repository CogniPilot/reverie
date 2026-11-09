use super::*;
use reverie_contracts::goal_custody::{GoalInventory, inventory_identifiers};
use std::{ffi::OsString, time::Duration};
pub(super) struct ObservedInventory {
    pub(super) data: GoalInventory,
    pub(super) started: Instant,
}
impl GoalCustodyAttempt {
    pub(super) fn inventory(
        &mut self,
        runtime: &WorkerRuntime,
        config: &GoalPrivateConfig,
        settings: &GoalWorkerSettings,
    ) -> Result<ObservedInventory> {
        settings.require_no_gpu_grants()?;
        let started = Instant::now();
        let ids = inventory_identifiers(
            &self.engine_query(
                runtime,
                ["ps", "--all", "--no-trunc", "--quiet"]
                    .map(Into::into)
                    .to_vec(),
            )?,
        )?;
        let mut args = vec![OsString::from("inspect")];
        args.extend(ids.iter().map(|id| OsString::from(id.as_str())));
        let identity = runtime.worker_identity();
        let data = GoalInventory::decode(
            &self.engine_query(runtime, args)?,
            &ids,
            config,
            identity.container(),
            identity.ids().uid(),
            identity.ids().gid(),
        )?;
        need(
            self.peer.uid() == identity.ids().uid() && self.peer.pid() > 0,
            "Goal custody caller refused",
        )?;
        let peer = self
            .files
            .namespace_inode(&std::path::PathBuf::from(format!(
                "/proc/{}/ns/mnt",
                self.peer.pid()
            )))?;
        let server = self
            .files
            .namespace_inode(&std::path::PathBuf::from(format!(
                "/proc/{}/ns/mnt",
                data.server_pid()
            )))?;
        need(peer == server, "Goal custody caller refused")?;
        Ok(ObservedInventory { data, started })
    }
    fn engine_query(&mut self, runtime: &WorkerRuntime, args: Vec<OsString>) -> Result<Vec<u8>> {
        need(
            self.identity.can_progress() && !runtime.cancellation().is_cancelled(),
            "Current Goal engine inventory unavailable",
        )?;
        need(
            self.pending.is_none(),
            "Current Goal engine inventory unavailable",
        )?;
        let end = Instant::now() + Duration::from_millis(500);
        match self.origin.engine.client.run_goal_inventory(
            args,
            end,
            &runtime.cancellation(),
            Policy {
                maximum: Duration::from_millis(500),
                maximum_output: 1024 * 1024,
                successful_exit: true,
            },
        ) {
            Ok(output) => {
                // The fixed Goal purpose sends stderr to DEVNULL. The retained
                // result has no stderr pipe; ordinary query modes keep both.
                std::str::from_utf8(&output.stderr).map_err(|_| {
                    GoalCustodyError::Refused("Current Goal engine inventory unavailable")
                })?;
                std::str::from_utf8(&output.stdout).map_err(|_| {
                    GoalCustodyError::Refused("Current Goal engine inventory unavailable")
                })?;
                Ok(output.stdout)
            }
            Err(failure) => {
                // These fixed calls are read-only. Keep their failed body
                // outcome, but let the SAME ticket's checked native settlement
                // establish resource closure. No query or projection is replayed.
                // The shared client retains consumed-close uncertainty itself.
                self.uncertain |= failure.call.is_none() && failure.error.may_have_started;
                self.pending = failure.call;
                Err(GoalCustodyError::Engine(failure.error.into()))
            }
        }
    }
}
