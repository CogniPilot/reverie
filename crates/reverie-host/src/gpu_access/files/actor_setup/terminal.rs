use super::*;
impl ActorSetupTerminal {
    pub fn assert_current(&self) -> SetupResult<()> {
        self.current()
            .map_err(|e| Rc::new(ActorSetupControlError::Host(e)))
    }
    pub(super) fn current(&self) -> Result<()> {
        self.proof.current()?;
        self.parents.assert_current()?;
        need(self.protected.unchanged()?, "ACTOR_SETUP_PROTECTED_CHANGED")?;
        for (path, stamp, group) in &self.leaves {
            need(
                GpuFileStamp::observe(path)? == *stamp
                    && fs::symlink_metadata(path)?.gid() == *group,
                "ACTOR_SETUP_TERMINAL_CHANGED",
            )?;
        }
        self.parents.assert_current()?;
        self.proof.current()
    }
    pub fn assert_history_additions(
        &self,
        root: &Path,
    ) -> SetupResult<Vec<(PathBuf, GpuFileStamp)>> {
        self.assert_current()?;
        need(root == self.proof.root, "ACTOR_SETUP_HISTORY_ROOT")
            .map_err(|e| Rc::new(ActorSetupControlError::Host(e)))?;
        let mut added = Vec::new();
        if self.proof.path.parent() == Some(root) {
            added.push((self.proof.path.clone(), self.proof.stamp.clone()));
        }
        let actor = root.join("resource-actor.json");
        let (_, stamp, _) = self
            .leaves
            .iter()
            .find(|(p, _, _)| p == &actor)
            .expect("actual third checked publication");
        added.push((actor, stamp.clone()));
        Ok(added)
    }
}
