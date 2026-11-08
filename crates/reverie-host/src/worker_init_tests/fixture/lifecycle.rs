use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
};

impl Fixture<'_> {
    fn inspect(&mut self) -> Result<serde_json::Value, String> {
        let id = self.id.clone().ok_or("original CID unknown")?;
        let raw = self.call(&["inspect", &id])?;
        let rows: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let row = &rows[0];
        if rows.as_array().map(Vec::len) != Some(1)
            || row["Id"] != id
            || row["Image"] != self.inputs.image
            || row["Name"] != format!("/{}", self.name)
        {
            return Err("original fixture identity changed".into());
        }
        if let Some(start) = &self.started
            && row["State"]["StartedAt"] != *start
        {
            return Err("original fixture restarted".into());
        }
        Ok(row.clone())
    }
    pub(super) fn observe_running(&mut self) {
        let row = self.inspect().unwrap();
        assert_eq!(row["State"]["Running"], true);
        assert_eq!(row["HostConfig"]["Init"], false);
        assert_eq!(row["HostConfig"]["RestartPolicy"]["Name"], "no");
        assert_eq!(row["Config"]["User"], "1000:100");
        assert!(
            row["HostConfig"]["CapAdd"].is_null()
                || row["HostConfig"]["CapAdd"] == serde_json::json!([])
        );
        assert_eq!(row["Config"]["Entrypoint"], serde_json::json!([INIT]));
        assert!(row["Config"]["Cmd"].is_null() || row["Config"]["Cmd"] == serde_json::json!([]));
        for (field, value) in [
            ("Privileged", serde_json::json!(false)),
            ("ReadonlyRootfs", serde_json::json!(true)),
            ("Memory", serde_json::json!(536870912)),
            ("MemorySwap", serde_json::json!(536870912)),
            ("PidsLimit", serde_json::json!(64)),
            ("NanoCpus", serde_json::json!(1000000000)),
            ("CapDrop", serde_json::json!(["ALL"])),
            ("NetworkMode", serde_json::json!("none")),
        ] {
            assert_eq!(row["HostConfig"][field], value, "{field}");
        }
        self.started = Some(row["State"]["StartedAt"].as_str().unwrap().to_owned());
        let pid = row["State"]["Pid"].as_u64().unwrap();
        assert!(pid > 1);
        self.observe_executable(pid);
        let id = self.id.as_ref().unwrap();
        let group = fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
        assert_eq!(group, format!("0::/system.slice/docker-{id}.scope\n"));
        let path = PathBuf::from("/sys/fs/cgroup/system.slice").join(format!("docker-{id}.scope"));
        for (name, expected) in [
            ("memory.max", "536870912"),
            ("memory.swap.max", "0"),
            ("pids.max", "64"),
            ("cpu.max", "100000 100000"),
            ("cpuset.cpus.effective", "0-7"),
        ] {
            assert_eq!(
                fs::read_to_string(path.join(name)).unwrap().trim(),
                expected,
                "{name}"
            );
        }
        assert!(
            !fs::read_to_string(path.join("cpuset.mems.effective"))
                .unwrap()
                .trim()
                .is_empty()
        );
    }
    fn observe_executable(&mut self, pid: u64) {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK)
            .open(format!("/proc/{pid}/exe"))
            .unwrap();
        let body = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let actual = file.metadata().unwrap();
            let expected = fs::symlink_metadata(&self.inputs.init).unwrap();
            assert_eq!(
                (actual.dev(), actual.ino()),
                (expected.dev(), expected.ino())
            );
            let mut bytes = Vec::new();
            (&mut file)
                .take(64 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .unwrap();
            assert!(bytes.len() <= 64 * 1024 * 1024);
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), self.inputs.digest);
        }));
        let closed = crate::native::close(file);
        self.unknown |= closed.is_err();
        if let Err(error) = body {
            std::panic::resume_unwind(error);
        }
        closed.unwrap();
    }
    pub(super) fn wait_stopped(&mut self, require_success: bool) -> Result<(), String> {
        let end = if require_success {
            self.signal_end
                .expect("original pre-effect signal deadline")
        } else {
            Instant::now() + Duration::from_secs(5)
        };
        loop {
            if Instant::now() >= end {
                return Err("original init observation deadline expired".into());
            }
            let row = self.inspect()?;
            // inspect itself may spend its entire native call budget. A late
            // stopped readback cannot retrospectively satisfy the five seconds.
            if Instant::now() >= end {
                return Err("original init observation completed late".into());
            }
            if row["State"]["Running"] == false && row["State"]["Pid"] == 0 {
                self.require_exit(&row, require_success)?;
                println!(
                    "INIT_FIXTURE_STOPPED originalCID={} signal={} actualExit={}",
                    self.id.as_ref().unwrap(),
                    self.signal,
                    row["State"]["ExitCode"]
                );
                return Ok(());
            }
            if Instant::now() >= end {
                return Err("original init remained running".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn require_exit(&self, row: &serde_json::Value, require_success: bool) -> Result<(), String> {
        if !require_success {
            return Ok(());
        }
        if row["State"]["ExitCode"] != 0 || row["State"]["OOMKilled"] != false {
            return Err(format!(
                "original init did not handle {} successfully: {}",
                self.signal, row["State"]
            ));
        }
        if row["State"]["Paused"] != false
            || row["State"]["Restarting"] != false
            || row["State"]["Dead"] != false
            || row["State"]["Error"] != ""
        {
            return Err("original init native exit metadata is unconfirmed".into());
        }
        Ok(())
    }
    pub(super) fn cleanup(&mut self) -> Result<(), String> {
        if self.cleanup_attempted {
            return Err("original fixture cleanup already attempted".into());
        }
        self.cleanup_attempted = true;
        let Some(id) = self.id.clone() else {
            return Err(
                "no original CID; preserve unique create attempt without name-based cleanup".into(),
            );
        };
        let row = self.inspect()?;
        if row["State"]["Running"] == true {
            assert!(!self.cleanup_kill_attempted);
            self.cleanup_kill_attempted = true;
            self.receipt("cleanup-kill-attempted", &id);
            self.call(&["kill", "--signal", "KILL", &id])?;
        }
        self.wait_stopped(false)?;
        if self.unknown {
            return Err("original CLI/metadata uncertainty remains sticky; no removal ACK".into());
        }
        self.receipt("remove-attempted", &id);
        self.call(&["rm", &id])?;
        println!("INIT_FIXTURE_REMOVED originalCID={id}");
        self.id = None;
        fs::remove_dir_all(&self.root).map_err(|e| e.to_string())?;
        self.complete = true;
        Ok(())
    }
}
impl Drop for Fixture<'_> {
    fn drop(&mut self) {
        if !self.complete {
            eprintln!(
                "INIT_FIXTURE_RETAINED name={} originalCID={:?} rawCreate={:?} root={}; no cleanup acknowledgement",
                self.name,
                self.id,
                self.raw_create,
                self.root.display()
            );
        }
    }
}
