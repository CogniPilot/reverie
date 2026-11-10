use super::*;
impl PerfProtectedStores {
    pub fn assert_current(&self) -> Result<()> {
        for (path, stamp) in &self.0 {
            need(
                GpuFileStamp::observe_optional(path)?.as_ref() == stamp.as_ref(),
                "PERF_PROTECTED_STORE_CHANGED",
            )?;
        }
        Ok(())
    }
}
impl PerfTerminal {
    pub fn assert_current(&self) -> Result<()> {
        need(Instant::now() < self.end, "PERF_PUBLICATION_DEADLINE")?;
        self.parents.assert_current()?;
        self.protected.assert_current()?;
        for (path, stamp) in &self.leaves {
            need(
                GpuFileStamp::observe_optional(path)?.as_ref() == stamp.as_ref(),
                "PERF_TERMINAL_CHANGED",
            )?;
        }
        for (path, group) in &self.groups {
            need(
                fs::symlink_metadata(path)?.gid() == *group,
                "PERF_SOURCE_GROUP_CHANGED",
            )?;
        }
        Ok(())
    }
}
