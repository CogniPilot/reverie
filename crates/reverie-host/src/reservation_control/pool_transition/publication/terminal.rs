use super::*;
use std::os::unix::fs::MetadataExt;

impl PoolTransitionPending {
    /// Call after the application's atomic in-memory publication and all its
    /// remaining observations. This does not close R or release pending.
    pub fn terminal(&self, publication: &PoolPublication) -> Result<PoolTerminal> {
        let owner = self.owner();
        owner.ledger.live()?;
        let result = (|| {
            need(
                Arc::ptr_eq(&publication.ledger, &owner.ledger),
                "POOL_PUBLICATION_FOREIGN",
            )?;
            need(owner.file.unreleased(), "POOL_PUBLICATION_PHASE")?;
            let state = owner
                .publication
                .as_ref()
                .ok_or(ControlHostError::Refused("POOL_PUBLICATION_PHASE"))?;
            need(state.phase == Phase::Published, "POOL_PUBLICATION_PHASE")?;
            let terminal = PoolTerminal {
                ledger: owner.ledger.clone(),
                proof: owner.proof.clone(),
                snapshot: state
                    .published
                    .as_ref()
                    .expect("same published pair")
                    .clone(),
            };
            terminal.assert_current()?;
            Ok(terminal)
        })();
        owner.ledger.finish(result)
    }
    /// LAST only after App has checked-close concluded its original admission.
    /// There is deliberately no caller boolean or JSON reconstruction path.
    pub fn release_terminal(&mut self, terminal: &PoolTerminal) -> Result<()> {
        let owner = self.owner_mut();
        owner.ledger.live()?;
        let result = (|| {
            need(
                Arc::ptr_eq(&terminal.ledger, &owner.ledger)
                    && Arc::ptr_eq(&terminal.proof, &owner.proof),
                "POOL_PUBLICATION_FOREIGN",
            )?;
            let state = owner
                .publication
                .as_mut()
                .ok_or(ControlHostError::Refused("POOL_PUBLICATION_PHASE"))?;
            need(state.phase == Phase::Published, "POOL_PUBLICATION_PHASE")?;
            terminal.assert_current()?;
            owner.file.assert_current().map_err(pending_error)?;
            owner
                .file
                .release_with_stop(state.end, &state.stop)
                .map_err(pending_error)?;
            state.phase = Phase::Released;
            Ok(())
        })();
        owner.ledger.finish(result)
    }
}
impl PoolTerminal {
    /// Brackets after-state leaves with the OLD pending inode and exact bytes;
    /// never applies the old configuration revision check to the new config.
    pub fn assert_current(&self) -> Result<()> {
        self.ledger.live()?;
        let result = (|| {
            self.proof.assert_current()?;
            self.snapshot.assert_current()?;
            self.proof.assert_current()?;
            self.snapshot.assert_current()?;
            need(
                Instant::now() < self.snapshot.deadline(),
                "POOL_PUBLICATION_DEADLINE",
            )
        })();
        self.ledger.finish(result)
    }
}
impl PublishedSnapshot {
    pub(super) fn assert_current(&self) -> Result<()> {
        need(
            Instant::now() < self.deadline(),
            "POOL_PUBLICATION_DEADLINE",
        )?;
        self.parents.assert_current()?;
        self.protected.assert_current()?;
        self.actor.assert_current()?;
        for (path, stamp, group) in &self.leaves {
            let info = fs::symlink_metadata(path)?;
            need(
                GpuFileStamp::of(&info) == *stamp && info.gid() == *group,
                "POOL_PUBLICATION_TERMINAL_CHANGED",
            )?;
        }
        need(
            Instant::now() < self.deadline(),
            "POOL_PUBLICATION_DEADLINE",
        )
    }
    fn deadline(&self) -> Instant {
        self.stop
            .deadline()
            .map_or(self.end, |stop| self.end.min(stop))
    }
}
