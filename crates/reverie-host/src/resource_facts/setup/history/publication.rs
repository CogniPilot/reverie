//! Only the actual writer's opaque pending/terminal may account for its exact
//! named root additions. All original child records and directory stamps stay.
use super::*;
use crate::gpu_access::{ActorSetupPending, ActorSetupTerminal, GpuFileStamp};
pub(super) enum HistoryPhase<'a> {
    Before,
    Pending(&'a ActorSetupPending),
    Published(&'a ActorSetupTerminal),
}
impl ActorSetupHistoryObservation {
    pub fn assert_pending(
        &mut self,
        pending: &ActorSetupPending,
    ) -> std::result::Result<(), Rc<ActorSetupHistoryError>> {
        self.assert_phase(HistoryPhase::Pending(pending))
    }
    pub fn assert_published(
        &mut self,
        terminal: &ActorSetupTerminal,
    ) -> std::result::Result<(), Rc<ActorSetupHistoryError>> {
        self.assert_phase(HistoryPhase::Published(terminal))
    }
    pub fn close_published(
        &mut self,
        terminal: &ActorSetupTerminal,
    ) -> std::result::Result<ActorSetupHistoryClosed<'_>, Rc<ActorSetupHistoryError>> {
        self.close_phase(HistoryPhase::Published(terminal))
    }
    fn assert_phase(
        &mut self,
        phase: HistoryPhase<'_>,
    ) -> std::result::Result<(), Rc<ActorSetupHistoryError>> {
        if let Some(cause) = &self.primary {
            return Err(Rc::clone(cause));
        }
        if let Some(cause) = &self.cleanup {
            return Err(Rc::clone(cause));
        }
        self.phase_current(&phase)
            .map_err(|cause| Rc::clone(self.primary.get_or_insert_with(|| Rc::new(cause))))
    }
    pub(super) fn close_phase(
        &mut self,
        phase: HistoryPhase<'_>,
    ) -> std::result::Result<ActorSetupHistoryClosed<'_>, Rc<ActorSetupHistoryError>> {
        if !self.close_attempted {
            self.close_attempted = true;
            let closed = self
                .files
                .as_mut()
                .map_or(Ok(()), |files| files.close().map_err(Into::into));
            let checked = self
                .files
                .as_ref()
                .map_or(Ok(()), |files| files.check().map_err(Into::into));
            let current = self
                .snapshot
                .as_ref()
                .map_or(Ok(()), |_| self.phase_current(&phase));
            if let Err(cause) = error::finalized(closed, error::finalized(checked, current)) {
                self.cleanup = Some(Rc::new(cause));
            }
        }
        if let Some(cause) = &self.cleanup
            && cause.has_unconfirmed_close()
        {
            return Err(Rc::clone(cause));
        }
        if let Some(cause) = &self.primary
            && cause.has_unconfirmed_close()
        {
            return Err(Rc::clone(cause));
        }
        Ok(ActorSetupHistoryClosed { _owner: self })
    }
    fn phase_current(&self, phase: &HistoryPhase<'_>) -> HistoryResult<()> {
        match phase {
            HistoryPhase::Before => self.metadata_current(),
            HistoryPhase::Pending(pending) => {
                let additions = pending
                    .assert_history_additions(&self.root)
                    .map_err(ActorSetupHistoryError::Publication)?;
                self.additions_current(&additions)?;
                pending
                    .assert_history_additions(&self.root)
                    .map_err(ActorSetupHistoryError::Publication)?;
                Ok(())
            }
            HistoryPhase::Published(terminal) => {
                let additions = terminal
                    .assert_history_additions(&self.root)
                    .map_err(ActorSetupHistoryError::Publication)?;
                self.additions_current(&additions)?;
                terminal
                    .assert_history_additions(&self.root)
                    .map_err(ActorSetupHistoryError::Publication)?;
                Ok(())
            }
        }
    }
    fn additions_current(&self, additions: &[(PathBuf, GpuFileStamp)]) -> HistoryResult<()> {
        self.time()?;
        self.assert_retained_expired()?;
        self.files
            .as_ref()
            .ok_or(ActorSetupHistoryError::Refused(
                "ACTOR_SETUP_HISTORY_NOT_OBSERVED",
            ))?
            .check()?;
        let snapshot = self
            .snapshot
            .as_ref()
            .ok_or(ActorSetupHistoryError::Refused(
                "ACTOR_SETUP_HISTORY_NOT_OBSERVED",
            ))?;
        let root = snapshot
            .directories
            .iter()
            .find(|directory| directory.path == self.root)
            .ok_or(ActorSetupHistoryError::Refused("ACTOR_SETUP_HISTORY_ROOT"))?;
        let info = std::fs::symlink_metadata(&self.root).map_err(GoalCustodyError::from)?;
        require(
            info.is_dir() && native::private_goal::identity(&info) == root.identity,
            "ACTOR_SETUP_HISTORY_CHANGED",
        )?;
        let root_stamp = GpuFileStamp::of(&info);
        let mut expected: BTreeSet<String> = root.names.iter().cloned().collect();
        for (path, stamp) in additions {
            require(
                path.parent() == Some(self.root.as_path()),
                "ACTOR_SETUP_HISTORY_FOREIGN_PUBLICATION",
            )?;
            let name = path.file_name().and_then(|name| name.to_str()).ok_or(
                ActorSetupHistoryError::Refused("ACTOR_SETUP_HISTORY_FOREIGN_PUBLICATION"),
            )?;
            require(
                [
                    "resource-actor.json",
                    "resource-reservation-control.pending",
                ]
                .contains(&name)
                    && (expected.insert(name.to_owned())
                        || (self.refresh && name == "resource-actor.json")),
                "ACTOR_SETUP_HISTORY_FOREIGN_PUBLICATION",
            )?;
            let info = std::fs::symlink_metadata(path).map_err(GoalCustodyError::from)?;
            require(
                GpuFileStamp::of(&info) == *stamp,
                "ACTOR_SETUP_HISTORY_CHANGED",
            )?;
        }
        let actual = reverie_store::operations::settlement_directory_names(&self.root)
            .map_err(ActorSetupHistoryError::Scan)?;
        let actual = actual
            .into_iter()
            .map(|name| {
                String::from_utf8(name).map_err(|_| {
                    ActorSetupHistoryError::Refused("ACTOR_SETUP_HISTORY_UNKNOWN_ENTRY")
                })
            })
            .collect::<HistoryResult<BTreeSet<_>>>()?;
        require(actual == expected, "ACTOR_SETUP_HISTORY_CHANGED")?;
        for directory in &snapshot.directories {
            if directory.path != self.root {
                directory.assert_current()?;
            }
        }
        for record in &snapshot.records {
            PrivateBatch::check_exact_private_json(&record.path, &record.stamp)?;
            let info = std::fs::symlink_metadata(&record.path).map_err(GoalCustodyError::from)?;
            require(info.gid() == record.group, "ACTOR_SETUP_HISTORY_CHANGED")?;
        }
        let info = std::fs::symlink_metadata(&self.root).map_err(GoalCustodyError::from)?;
        require(
            info.is_dir()
                && native::private_goal::identity(&info) == root.identity
                && GpuFileStamp::of(&info) == root_stamp,
            "ACTOR_SETUP_HISTORY_CHANGED",
        )?;
        self.files.as_ref().expect("same history owner").check()?;
        self.time()
    }
}
