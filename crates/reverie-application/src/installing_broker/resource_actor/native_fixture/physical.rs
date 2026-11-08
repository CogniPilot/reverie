//! Supplemental physical fixture readback, never a Q or worker-pool permit.
use super::*;
impl Fixture {
    pub(super) fn physical(&self, phase: &'static str) -> CaseResult<()> {
        let item = self.container()?;
        require(
            item["State"]["Running"] == true,
            "actual fixture Node must be running",
        )?;
        let pid = item["State"]["Pid"]
            .as_u64()
            .ok_or_else(|| "actual fixture PID absent".to_owned())?;
        let status = fs::read(format!("/proc/{pid}/status")).map_err(reason)?;
        reverie_contracts::resource_actor::require_peer_kernel_status(&status).map_err(reason)?;
        let raw = fs::read_to_string(format!("/proc/{pid}/cgroup")).map_err(reason)?;
        let paths = raw
            .lines()
            .filter_map(|line| line.strip_prefix("0::"))
            .collect::<Vec<_>>();
        require(paths.len() == 1, "fixture requires actual unified cgroup")?;
        let path = Path::new(paths[0]);
        require(
            path.is_absolute()
                && path.components().all(|p| {
                    matches!(
                        p,
                        std::path::Component::RootDir | std::path::Component::Normal(_)
                    )
                }),
            "actual cgroup path invalid",
        )?;
        let directory = Path::new("/sys/fs/cgroup").join(path.strip_prefix("/").map_err(reason)?);
        let mut limits = BTreeMap::new();
        for name in [
            "memory.max",
            "memory.high",
            "memory.swap.max",
            "cpu.max",
            "cpu.weight",
            "pids.max",
            "cpuset.cpus.effective",
        ] {
            limits.insert(
                name,
                fs::read_to_string(directory.join(name))
                    .map_err(reason)?
                    .trim()
                    .to_owned(),
            );
        }
        require(
            limits["memory.max"] == "536870912"
                && limits["memory.high"] == "max"
                && limits["memory.swap.max"] == "0"
                && limits["pids.max"] == "256"
                && limits["cpu.max"].split_ascii_whitespace().next() == Some("max")
                && limits["cpu.weight"] == "100"
                && limits["cpuset.cpus.effective"] == "0-7",
            "actual fixture kernel limits differ",
        )?;
        let info = fs::metadata(&directory).map_err(reason)?;
        self.tree().write(&format!("fixture-physical-{phase}.json"),&serde_json::to_vec(&json!({"cid":self.cid,"initAndDirectNodePeerPid":pid,"path":paths[0],"identity":[info.dev(),info.ino()],"limits":limits,"scope":"supplemental512MiBwebsiteOnlyNotPoolProof"})).map_err(reason)?);
        Ok(())
    }
}
