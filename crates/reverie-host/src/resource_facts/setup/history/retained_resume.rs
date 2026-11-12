//! A negative UNKNOWN observation under real deployment exclusion. No old
//! resume result, closure, capacity or replay permission is manufactured.
use super::*;
use reverie_core::operations::JournalId;
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
impl ActorSetupHistoryObservation {
    pub(super) fn retain_expired_resume(
        &mut self,
        snapshot: &mut Snapshot,
        path: &Path,
        operation: &JournalId,
        active: &[u8],
        purpose: &mut HistoryPurpose<'_>,
    ) -> HistoryResult<()> {
        let HistoryPurpose::InitialActorSetup(locks) = purpose else {
            return Err(ActorSetupHistoryError::Refused(
                "ACTOR_SETUP_RESUME_ACTIVE_OR_BOUND",
            ));
        };
        let names = self.directory(snapshot, path)?;
        require(
            ["PLAN.json", "ATTEMPT.json", "operation.lock"]
                .iter()
                .all(|n| names.contains(*n)),
            "ACTOR_SETUP_RESUME_UNKNOWN_PREFIX",
        )?;
        for name in &names {
            require(
                ["PLAN.json", "ATTEMPT.json", "operation.lock"].contains(&name.as_str())
                    || resume::step_name(name),
                "ACTOR_SETUP_RESUME_UNKNOWN_PREFIX",
            )?;
        }
        self.resume_operation_lock(snapshot, path, &names)?;
        let plan = self.payload_record(snapshot, &path.join("PLAN.json"))?;
        let attempt = self.small_record(snapshot, &path.join("ATTEMPT.json"))?;
        let namespace = std::fs::symlink_metadata(path.parent().expect("fixed resume parent"))
            .map_err(GoalCustodyError::from)?;
        let operation_info = std::fs::symlink_metadata(path).map_err(GoalCustodyError::from)?;
        let identity = |info: &std::fs::Metadata| {
            [
                info.dev(),
                info.ino(),
                u64::from(info.uid()),
                u64::from(info.gid()),
            ]
        };
        let data = actor_setup_history::RetainedExpiredResumeData::capture(
            active,
            &plan,
            &attempt,
            operation,
            [identity(&namespace), identity(&operation_info)],
            epoch()?,
        )?;
        locks
            .assert_actor_setup_resume_maintenance(Path::new(data.deployment_path()))
            .map_err(ActorSetupHistoryError::Maintenance)?;
        self.retained = Some(data);
        for name in names {
            if resume::step_name(&name) {
                self.payload_record(snapshot, &path.join(name))?;
            }
        }
        self.files.as_ref().expect("same reader").check()?;
        locks
            .assert_actor_setup_resume_maintenance(Path::new(
                self.retained
                    .as_ref()
                    .expect("same UNKNOWN data")
                    .deployment_path(),
            ))
            .map_err(ActorSetupHistoryError::Maintenance)?;
        self.assert_retained_expired()
    }
    pub(super) fn resume_operation_lock(
        &mut self,
        snapshot: &mut Snapshot,
        path: &Path,
        names: &BTreeSet<String>,
    ) -> HistoryResult<()> {
        if names.contains("operation.lock") {
            let path = path.join("operation.lock");
            self.inspect_record(snapshot, &path)?;
            require(
                std::fs::symlink_metadata(path)
                    .map_err(GoalCustodyError::from)?
                    .len()
                    == 0,
                "ACTOR_SETUP_RESUME_OPERATION_LOCK",
            )?;
        }
        Ok(())
    }
    pub(super) fn assert_retained_expired(&self) -> HistoryResult<()> {
        if let Some(data) = &self.retained {
            data.assert_expired(epoch()?)?;
        }
        Ok(())
    }
    pub fn assert_initial_actor_setup_maintenance(
        &self,
        locks: &mut crate::worker_image::ImageMaintenanceLocks,
    ) -> std::result::Result<(), Rc<ActorSetupHistoryError>> {
        if let Some(data) = &self.retained {
            locks
                .assert_actor_setup_resume_maintenance(Path::new(data.deployment_path()))
                .map_err(|e| Rc::new(ActorSetupHistoryError::Maintenance(e)))?;
        }
        self.assert_current()
    }
}
fn epoch() -> HistoryResult<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|n| n.as_secs())
        .map_err(|_| ActorSetupHistoryError::Refused("ACTOR_SETUP_RESUME_CLOCK"))
}
