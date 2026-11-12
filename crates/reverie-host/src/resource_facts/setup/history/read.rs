use super::*;
use std::path::Path;

impl ActorSetupHistoryObservation {
    pub(super) fn read_snapshot(&mut self, mut purpose: HistoryPurpose<'_>) -> HistoryResult<()> {
        self.time()?;
        self.files = Some(PrivateBatch::new()?);
        let mut snapshot = Snapshot {
            directories: Vec::new(),
            records: Vec::new(),
        };
        let root = self.root.clone();
        let names = self.directory(&mut snapshot, &root)?;
        exact_names(
            &names,
            &["admission.lock", "operations", "profiles"],
            if self.refresh {
                &[
                    "host-resume",
                    "host-resume.namespace.json",
                    "resource-actor.json",
                ]
            } else {
                &["host-resume", "host-resume.namespace.json"]
            },
        )?;
        require(
            !self.refresh || names.contains("resource-actor.json"),
            "ACTOR_REFRESH_PREVIOUS_MISSING",
        )?;
        self.inspect_record(&mut snapshot, &root.join("admission.lock"))?;
        let operations = root.join("operations");
        let names = self.directory(&mut snapshot, &operations)?;
        exact_names(
            &names,
            &["operations.lock", "operations.json"],
            &["task-perf-owner-requests.json"],
        )?;
        self.inspect_record(&mut snapshot, &operations.join("operations.lock"))?;
        let raw = self.small_record(&mut snapshot, &operations.join("operations.json"))?;
        actor_setup_history::require_empty_operations(&raw)?;
        if names.contains("task-perf-owner-requests.json") {
            let raw = self.small_record(
                &mut snapshot,
                &operations.join("task-perf-owner-requests.json"),
            )?;
            actor_setup_history::validate_task_perf_requests(&raw)?;
        }
        let profiles = root.join("profiles");
        let names = self.directory(&mut snapshot, &profiles)?;
        exact_names(&names, &["profiles.lock"], &["profiles.json"])?;
        self.inspect_record(&mut snapshot, &profiles.join("profiles.lock"))?;
        if names.contains("profiles.json") {
            let raw = self.small_record(&mut snapshot, &profiles.join("profiles.json"))?;
            actor_setup_history::require_empty_profiles(&raw)?;
        }
        self.resume_history(&mut snapshot, &root, &mut purpose)?;
        self.files.as_ref().expect("same private reader").check()?;
        self.snapshot = Some(snapshot);
        self.metadata_current()
    }
    pub(super) fn directory(
        &mut self,
        snapshot: &mut Snapshot,
        path: &Path,
    ) -> HistoryResult<BTreeSet<String>> {
        self.count()?;
        self.files
            .as_mut()
            .expect("same reader")
            .inspect(path, true, false)?;
        let info = std::fs::symlink_metadata(path).map_err(GoalCustodyError::from)?;
        require(
            info.is_dir()
                && info.uid() == native::uid()
                && info.gid() == nix::unistd::getegid().as_raw()
                && info.mode() & 0o7777 == 0o700,
            "ACTOR_SETUP_HISTORY_DIRECTORY",
        )?;
        let mut directory = Directory {
            path: path.to_owned(),
            stamp: crate::gpu_access::GpuFileStamp::of(&info),
            group: info.gid(),
            projection: native::private_goal::projection(&Fingerprint::of(&info)),
            names: Vec::new(),
            identity: native::private_goal::identity(&info),
        };
        let names = reverie_store::operations::settlement_directory_names(path)
            .map_err(ActorSetupHistoryError::Scan)?;
        require(names.len() <= 512, "ACTOR_SETUP_HISTORY_BOUND")?;
        let mut selected = BTreeSet::new();
        for name in names {
            let name = String::from_utf8(name).map_err(|_| {
                ActorSetupHistoryError::Refused("ACTOR_SETUP_HISTORY_UNKNOWN_ENTRY")
            })?;
            require(
                !name.is_empty() && !name.contains('/') && selected.insert(name),
                "ACTOR_SETUP_HISTORY_UNKNOWN_ENTRY",
            )?;
        }
        directory.assert_current()?;
        self.files.as_ref().expect("same reader").check()?;
        self.time()?;
        directory.names = selected.iter().cloned().collect();
        snapshot.directories.push(directory);
        Ok(selected)
    }
    pub(super) fn inspect_record(
        &mut self,
        snapshot: &mut Snapshot,
        path: &Path,
    ) -> HistoryResult<()> {
        self.count()?;
        self.files
            .as_mut()
            .expect("same reader")
            .inspect(path, false, false)?;
        let info = record_info(path)?;
        snapshot.records.push(Record {
            path: path.to_owned(),
            stamp: Fingerprint::of(&info),
            group: info.gid(),
            digest: None,
        });
        Ok(())
    }
    pub(super) fn small_record(
        &mut self,
        snapshot: &mut Snapshot,
        path: &Path,
    ) -> HistoryResult<Vec<u8>> {
        self.read_record(snapshot, path, RecordPurpose::Metadata)
    }
    pub(super) fn payload_record(
        &mut self,
        snapshot: &mut Snapshot,
        path: &Path,
    ) -> HistoryResult<Vec<u8>> {
        self.read_record(snapshot, path, RecordPurpose::ResumePayload)
    }
    fn read_record(
        &mut self,
        snapshot: &mut Snapshot,
        path: &Path,
        purpose: RecordPurpose,
    ) -> HistoryResult<Vec<u8>> {
        self.count()?;
        let remaining = (16 * 1024 * 1024_usize)
            .checked_sub(self.bytes)
            .ok_or(ActorSetupHistoryError::Refused("ACTOR_SETUP_HISTORY_BOUND"))?;
        let files = self.files.as_mut().expect("same reader");
        let (stamp, raw) = match purpose {
            RecordPurpose::Metadata => files.read_actor_history_metadata(path, remaining)?,
            RecordPurpose::ResumePayload => files.read_actor_history_record(path, remaining)?,
        };
        self.bytes = self
            .bytes
            .checked_add(raw.len())
            .ok_or(ActorSetupHistoryError::Refused("ACTOR_SETUP_HISTORY_BOUND"))?;
        require(self.bytes <= 16 * 1024 * 1024, "ACTOR_SETUP_HISTORY_BOUND")?;
        let info = record_info(path)?;
        let digest = {
            use sha2::Digest;
            sha2::Sha256::digest(&raw).into()
        };
        snapshot.records.push(Record {
            path: path.to_owned(),
            stamp,
            group: info.gid(),
            digest: Some(digest),
        });
        Ok(raw)
    }
    fn count(&mut self) -> HistoryResult<()> {
        self.time()?;
        self.entries += 1;
        require(self.entries <= 512, "ACTOR_SETUP_HISTORY_BOUND")
    }
}
enum RecordPurpose {
    Metadata,
    ResumePayload,
}
fn record_info(path: &Path) -> HistoryResult<std::fs::Metadata> {
    let info = std::fs::symlink_metadata(path).map_err(GoalCustodyError::from)?;
    require(
        info.is_file()
            && info.uid() == native::uid()
            && info.gid() == nix::unistd::getegid().as_raw()
            && info.mode() & 0o7777 == 0o600
            && info.nlink() == 1,
        "ACTOR_SETUP_HISTORY_RECORD",
    )?;
    Ok(info)
}
pub(super) fn exact_names(
    names: &BTreeSet<String>,
    required: &[&str],
    optional: &[&str],
) -> HistoryResult<()> {
    require(
        required.iter().all(|name| names.contains(*name))
            && names
                .iter()
                .all(|name| required.contains(&name.as_str()) || optional.contains(&name.as_str())),
        "ACTOR_SETUP_HISTORY_UNKNOWN_ENTRY",
    )
}
