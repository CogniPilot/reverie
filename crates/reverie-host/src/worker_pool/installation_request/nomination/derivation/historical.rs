//! Only previously preserved negative controller records. No label/name alone
//! exempts a container, and no historical match grants install/close/replay.
use super::*;
use reverie_contracts::worker_pool::{ControllerBirthV2, RetiredControllerData};
use reverie_core::ids::{ContainerId, ProfileSessionId};
use reverie_core::operations::JournalDigest;
use std::{ffi::OsStr, io::Read};

#[derive(Default)]
pub(super) struct HistoricalRetirements {
    batch: Option<PrivateBatch>,
    entries: Vec<Entry>,
    immutable: ImmutableInputObserver,
    close_attempted: bool,
    close_unknown: bool,
}
struct Entry {
    name: String,
    id: ContainerId,
    receipt: RetiredControllerData,
    request: Vec<u8>,
    birth: ArchiveBirth,
    binding: Option<ControllerBirthV2>,
    stamps: Vec<(PathBuf, Fingerprint)>,
}
#[derive(Default)]
struct ArchiveBirth {
    closed: bool,
    history: Option<File>,
    directory: Option<File>,
    file: Option<File>,
    paths: Vec<(PathBuf, native::private_goal::PathIdentity)>,
    path: PathBuf,
    stamp: Option<native::PrivateFileStamp>,
    bytes: Vec<u8>,
}
impl HistoricalRetirements {
    pub(super) fn contains_validated_policy(
        &self,
        digest: &JournalDigest,
        principal: &reverie_contracts::resource_actor::ResourceOwnerPrincipal,
    ) -> Result<bool> {
        use sha2::Digest;
        self.assert_current()?;
        for entry in &self.entries {
            let Some(birth) = &entry.binding else {
                continue;
            };
            let request = PoolInstallationRequestData::decode(&entry.request)?;
            if request.principal().account_id() == principal.account_id()
                && request.principal().person_id() == principal.person_id()
                && request.principal().session_epoch() == principal.session_epoch()
                && format!(
                    "{:x}",
                    sha2::Sha256::digest(serde_json::to_vec(birth.policy()).map_err(|_| {
                        PoolNominationError::Refused("POOL_PENDING_POLICY_ENCODING")
                    })?)
                ) == digest.as_str()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub(super) fn matches_row(
        &mut self,
        policy: &WorkerPoolPolicy,
        id: &ContainerId,
        row: &serde_json::Value,
        end: Instant,
    ) -> Result<bool> {
        need(!self.close_attempted, "POOL_RETIRED_HISTORY_CLOSED")?;
        let name = row["Name"]
            .as_str()
            .ok_or(PoolNominationError::Refused("POOL_NOMINATION_CENSUS"))?;
        let Some(nonce) = name.strip_prefix(&format!("/{}-failed-", policy.controller_name()))
        else {
            return Ok(false);
        };
        ProfileSessionId::parse(nonce)
            .map_err(|_| PoolNominationError::Refused("POOL_RETIRED_HISTORY_NAME"))?;
        if !self.entries.iter().any(|entry| entry.id == *id) {
            need(self.entries.len() < 16, "POOL_RETIRED_HISTORY_BOUND")?;
            self.capture(policy, id, name.trim_start_matches('/'), nonce)?;
        }
        self.assert_current()?;
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == *id)
            .expect("captured exact historical CID");
        need(
            name == format!("/{}", entry.name),
            "POOL_RETIRED_HISTORY_NAME_CHANGED",
        )?;
        let raw = serde_json::to_vec(row)
            .map_err(|_| PoolNominationError::Refused("POOL_RETIRED_HISTORY_DATA"))?;
        let birth = entry
            .receipt
            .bind(
                &entry.request,
                &entry.birth.bytes,
                policy,
                id.as_str(),
                &entry.name,
                &raw,
            )
            .map_err(|_| PoolNominationError::Refused("POOL_RETIRED_HISTORY_BINDING"))?;
        self.immutable
            .observe_broker_program(birth.program(), end)?;
        require_absent(&format!("/proc/{}", birth.broker().pid()))?;
        require_absent(&format!(
            "/sys/fs/cgroup/system.slice/docker-{}.scope",
            id.as_str()
        ))?;
        entry.binding = Some(birth);
        self.assert_current()?;
        Ok(true)
    }
    fn capture(
        &mut self,
        policy: &WorkerPoolPolicy,
        id: &ContainerId,
        name: &str,
        nonce: &str,
    ) -> Result<()> {
        if self.batch.is_none() {
            self.batch = Some(PrivateBatch::new()?);
        }
        let root = PathBuf::from(&policy.instance_root)
            .join("worker-pool/nomination-history")
            .join(nonce);
        let reader = self.batch.as_mut().expect("retained history reader");
        let receipt_path = root.join("retired-negative.json");
        let (receipt_stamp, receipt_raw) =
            reader.read_actor_history_metadata(&receipt_path, 65_536)?;
        let receipt = RetiredControllerData::decode(&receipt_raw)
            .map_err(|_| PoolNominationError::Refused("POOL_RETIRED_HISTORY_RECEIPT"))?;
        let request_path = root.join("request-before.json");
        let (request_stamp, request) = reader.read_actor_history_metadata(&request_path, 65_536)?;
        self.entries.push(Entry {
            name: name.to_owned(),
            id: id.clone(),
            receipt,
            request,
            birth: ArchiveBirth::default(),
            binding: None,
            stamps: vec![(receipt_path, receipt_stamp), (request_path, request_stamp)],
        });
        let entry = self
            .entries
            .last_mut()
            .expect("original partial history retained");
        entry
            .birth
            .capture(&root, entry.receipt.birth_digest(), policy)?;
        reader.check()?;
        Ok(())
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        need(!self.close_unknown, "POOL_RETIRED_HISTORY_CLOSE_UNKNOWN")?;
        self.immutable.assert_finalized()?;
        if let Some(reader) = &self.batch {
            reader.check()?;
        }
        for entry in &self.entries {
            for (path, stamp) in &entry.stamps {
                PrivateBatch::check_exact_private_json(path, stamp)?;
            }
            entry.birth.assert_current()?;
            if let Some(binding) = &entry.binding {
                require_absent(&format!("/proc/{}", binding.broker().pid()))?;
                require_absent(&format!(
                    "/sys/fs/cgroup/system.slice/docker-{}.scope",
                    entry.id.as_str()
                ))?;
            }
        }
        Ok(())
    }
    pub(super) fn close(&mut self) -> Result<()> {
        if self.close_attempted {
            return need(!self.close_unknown, "POOL_RETIRED_HISTORY_CLOSE_UNKNOWN");
        }
        let checked = self.assert_current();
        self.close_attempted = true;
        let mut result = checked;
        for entry in &mut self.entries {
            result = finalized(result, entry.birth.close());
        }
        result = finalized(
            result,
            self.batch
                .as_mut()
                .map_or(Ok(()), |reader| reader.close().map_err(Into::into)),
        );
        self.close_unknown = result.is_err();
        result
    }
}
impl ArchiveBirth {
    fn capture(&mut self, root: &Path, digest: &str, policy: &WorkerPoolPolicy) -> Result<()> {
        self.history = Some(native::open_at(
            libc::AT_FDCWD,
            root.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?);
        let history = self.history.as_ref().expect("retained history");
        let info = history.metadata()?;
        need(
            info.is_dir() && info.uid() == policy.broker_uid && info.mode() & 0o7777 == 0o700,
            "POOL_RETIRED_HISTORY_CUSTODY",
        )?;
        self.paths
            .push((root.to_owned(), native::private_goal::identity(&info)));
        self.directory = Some(native::open_at(
            history.as_raw_fd(),
            OsStr::new("policies-before"),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?);
        let directory = self.directory.as_ref().expect("retained archived policies");
        let info = directory.metadata()?;
        need(
            info.is_dir()
                && info.uid() == policy.broker_uid
                && info.gid() == policy.broker_gid
                && info.mode() & 0o7777 == 0o750,
            "POOL_RETIRED_HISTORY_CUSTODY",
        )?;
        self.paths.push((
            root.join("policies-before"),
            native::private_goal::identity(&info),
        ));
        let leaf = format!("{digest}.json");
        self.path = root.join("policies-before").join(&leaf);
        self.file = Some(native::open_at(
            directory.as_raw_fd(),
            OsStr::new(&leaf),
            libc::O_RDONLY | libc::O_NONBLOCK,
        )?);
        let file = self.file.as_ref().expect("original archived birth");
        let info = file.metadata()?;
        need(
            info.is_file()
                && info.uid() == policy.broker_uid
                && info.gid() == policy.broker_gid
                && info.nlink() == 1
                && info.mode() & 0o7777 == 0o440
                && (1..=65_536).contains(&info.len()),
            "POOL_RETIRED_HISTORY_CUSTODY",
        )?;
        self.stamp = Some(native::PrivateFileStamp::of(&info));
        file.take(65_537).read_to_end(&mut self.bytes)?;
        need(
            self.bytes.len() <= 65_536 && self.bytes.len() as u64 == info.len(),
            "POOL_RETIRED_HISTORY_BOUND",
        )?;
        self.assert_current()
    }
    fn assert_current(&self) -> Result<()> {
        for (index, (path, identity)) in self.paths.iter().enumerate() {
            let held = if index == 0 {
                &self.history
            } else {
                &self.directory
            };
            need(
                native::private_goal::identity(&fs::symlink_metadata(path)?) == *identity
                    && (self.closed
                        || held.as_ref().is_some_and(|file| {
                            file.metadata()
                                .is_ok_and(|m| native::private_goal::identity(&m) == *identity)
                        })),
                "POOL_RETIRED_HISTORY_CHANGED",
            )?;
        }
        if let Some(stamp) = &self.stamp {
            need(
                (self.closed
                    || self.file.as_ref().is_some_and(|file| {
                        file.metadata()
                            .is_ok_and(|m| native::PrivateFileStamp::of(&m) == *stamp)
                    }))
                    && native::PrivateFileStamp::of(&fs::symlink_metadata(&self.path)?) == *stamp,
                "POOL_RETIRED_HISTORY_CHANGED",
            )?;
        }
        Ok(())
    }
    fn close(&mut self) -> Result<()> {
        let file = self
            .file
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into));
        let directory = self
            .directory
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into));
        let history = self
            .history
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into));
        let result = finalized(file, finalized(directory, history));
        self.closed = result.is_ok();
        result
    }
}
fn require_absent(path: &str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(PoolNominationError::Refused(
            "POOL_RETIRED_HISTORY_PROCESS_PRESENT",
        )),
    }
}
