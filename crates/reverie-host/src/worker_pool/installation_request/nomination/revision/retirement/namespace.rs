use super::*;
use reverie_contracts::worker_pool::{ControllerBirthV2, WorkerPoolPolicy};
use sha2::Digest;
use std::{ffi::OsStr, io::Read};

type RetainedBirthFile = (
    String,
    Option<File>,
    Option<native::PrivateFileStamp>,
    Vec<u8>,
);

#[derive(Default)]
pub(super) struct Namespace {
    root: PathBuf,
    history: Option<PathBuf>,
    directories: Vec<(Option<File>, Option<native::private_goal::PathIdentity>)>,
    files: Vec<RetainedBirthFile>,
    selected: Option<ControllerBirthV2>,
    policy: Option<WorkerPoolPolicy>,
    attempted: bool,
    archived: bool,
    closed: bool,
    close_attempted: bool,
    close_error: Option<Box<PoolNominationError>>,
}
impl Namespace {
    pub(super) fn capture(&mut self, policy: &WorkerPoolPolicy, birth: &str) -> Result<()> {
        need(
            self.policy.is_none(),
            "POOL_RETIRE_NAMESPACE_ALREADY_CAPTURED",
        )?;
        self.policy = Some(policy.clone());
        self.root = PathBuf::from(&policy.instance_root).join("worker-pool");
        for (name, mode) in [("policies", 0o750), ("control", 0o770)] {
            let file = native::open_at(
                nix::libc::AT_FDCWD,
                self.root.join(name).as_os_str(),
                nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
            )?;
            self.directories.push((Some(file), None));
            let info = self
                .directories
                .last()
                .expect("retained directory")
                .0
                .as_ref()
                .expect("original descriptor")
                .metadata()?;
            need(
                info.is_dir()
                    && info.uid() == policy.broker_uid
                    && info.gid() == policy.broker_gid
                    && info.mode() & 0o7777 == mode,
                "POOL_RETIRE_NAMESPACE_CUSTODY",
            )?;
            self.directories.last_mut().expect("same directory").1 =
                Some(native::private_goal::identity(&info));
        }
        need(
            reverie_store::operations::settlement_directory_names(&self.root.join("control"))?
                .is_empty(),
            "POOL_RETIRE_ENDPOINT_RETAINED",
        )?;
        let names =
            reverie_store::operations::settlement_directory_names(&self.root.join("policies"))?;
        need(
            !names.is_empty() && names.len() <= 32,
            "POOL_RETIRE_POLICY_COUNT",
        )?;
        for name in names {
            self.read_birth(policy, birth, name)?;
        }
        need(
            self.selected.is_some(),
            "POOL_RETIRE_ORIGINAL_BIRTH_REQUIRED",
        )?;
        self.assert_current()
    }
    fn read_birth(
        &mut self,
        policy: &WorkerPoolPolicy,
        selected: &str,
        name: Vec<u8>,
    ) -> Result<()> {
        let name = String::from_utf8(name)
            .map_err(|_| PoolNominationError::Refused("POOL_RETIRE_POLICY_NAME"))?;
        let digest = name
            .strip_suffix(".json")
            .and_then(|s| JournalDigest::parse(s).ok())
            .ok_or(PoolNominationError::Refused("POOL_RETIRE_POLICY_NAME"))?;
        let file = native::open_at(
            self.directories[0]
                .0
                .as_ref()
                .expect("captured directory")
                .as_raw_fd(),
            OsStr::new(&name),
            nix::libc::O_RDONLY | nix::libc::O_NONBLOCK,
        )?;
        self.files
            .push((name.clone(), Some(file), None, Vec::new()));
        let info = self
            .files
            .last()
            .expect("retained file")
            .1
            .as_ref()
            .expect("original descriptor")
            .metadata()?;
        self.files.last_mut().expect("same file").2 = Some(native::PrivateFileStamp::of(&info));
        need(
            info.is_file()
                && info.uid() == policy.broker_uid
                && info.gid() == policy.broker_gid
                && info.mode() & 0o7777 == 0o440
                && info.nlink() == 1
                && (1..=65536).contains(&info.len()),
            "POOL_RETIRE_POLICY_CUSTODY",
        )?;
        let row = self.files.last_mut().expect("original file retained");
        row.1
            .as_ref()
            .expect("retained file")
            .take(65537)
            .read_to_end(&mut row.3)?;
        let birth = ControllerBirthV2::decode(&row.3)
            .map_err(|_| PoolNominationError::Refused("POOL_RETIRE_POLICY_DATA"))?;
        need(
            birth
                .encode()
                .map_err(|_| PoolNominationError::Refused("POOL_RETIRE_POLICY_DATA"))?
                == row.3
                && format!("{:x}", sha2::Sha256::digest(&row.3)) == digest.as_str(),
            "POOL_RETIRE_POLICY_DIGEST",
        )?;
        let mut historical = birth.policy().clone();
        historical.employee_memory_high_mi_b = policy.employee_memory_high_mi_b.clone();
        need(historical == *policy, "POOL_RETIRE_POLICY_BINDING")?;
        if digest.as_str() == selected {
            need(
                birth.policy() == policy && self.selected.is_none(),
                "POOL_RETIRE_SELECTED_POLICY",
            )?;
            self.selected = Some(birth);
        }
        Ok(())
    }
    pub(super) fn birth(&self) -> Result<&ControllerBirthV2> {
        self.selected.as_ref().ok_or(PoolNominationError::Refused(
            "POOL_RETIRE_ORIGINAL_BIRTH_REQUIRED",
        ))
    }
    pub(super) fn archive(
        &mut self,
        owner: &NominationOwner,
        publication: &publication::Publication,
        locks: &mut ImageMaintenanceLocks,
        service: &ImageServiceMaintenance,
    ) -> Result<()> {
        need(!self.attempted, "POOL_RETIRE_NAMESPACE_ALREADY_ATTEMPTED")?;
        self.assert_current()?;
        publication.assert_history_bound(owner)?;
        self.attempted = true;
        self.history = Some(publication.history_path().to_path_buf());
        publication::fence(owner, locks, service)?;
        native::archive_failed_pool_policies(
            &owner
                .directories
                .as_ref()
                .expect("original parent")
                .directories[1],
            publication.history_fd(),
        )?;
        publication::fence(owner, locks, service)?;
        publication.assert_history_bound(owner)?;
        native::archive_failed_pool_control(
            &owner
                .directories
                .as_ref()
                .expect("original parent")
                .directories[1],
            publication.history_fd(),
        )?;
        publication.history_fd().sync_all()?;
        owner.directories.as_ref().expect("same parent").directories[1].sync_all()?;
        self.archived = true;
        self.assert_current()
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        if let Some(error) = &self.close_error {
            return Err(PoolNominationError::Refused(error.code()));
        }
        need(
            self.policy.is_some()
                && self.directories.len() == 2
                && self.selected.is_some()
                && !self.files.is_empty(),
            "POOL_RETIRE_NAMESPACE_INCOMPLETE",
        )?;
        let root = if self.archived {
            self.history.as_ref().expect("known archive")
        } else {
            &self.root
        };
        for (index, name) in ["policies", "control"].into_iter().enumerate() {
            let leaf = if self.archived {
                format!("{name}-before")
            } else {
                name.to_owned()
            };
            let info = fs::symlink_metadata(root.join(&leaf))?;
            need(
                Some(native::private_goal::identity(&info)) == self.directories[index].1,
                "POOL_RETIRE_NAMESPACE_CHANGED",
            )?;
            if !self.closed {
                need(
                    Some(native::private_goal::identity(
                        &self.directories[index]
                            .0
                            .as_ref()
                            .ok_or(PoolNominationError::Refused("POOL_RETIRE_DIRECTORY_CLOSED"))?
                            .metadata()?,
                    )) == self.directories[index].1,
                    "POOL_RETIRE_NAMESPACE_CHANGED",
                )?;
            }
            let names = reverie_store::operations::settlement_directory_names(&root.join(&leaf))?;
            let mut expected: Vec<Vec<u8>> = if index == 0 {
                self.files.iter().map(|r| r.0.as_bytes().to_vec()).collect()
            } else {
                Vec::new()
            };
            let mut names = names;
            names.sort();
            expected.sort();
            need(names == expected, "POOL_RETIRE_NAMESPACE_CHANGED")?;
        }
        for (name, file, stamp, raw) in &self.files {
            need(
                !raw.is_empty()
                    && Some(native::PrivateFileStamp::of(&fs::symlink_metadata(
                        root.join(if self.archived {
                            "policies-before"
                        } else {
                            "policies"
                        })
                        .join(name),
                    )?)) == *stamp,
                "POOL_RETIRE_POLICY_CHANGED",
            )?;
            if !self.closed {
                need(
                    Some(native::PrivateFileStamp::of(
                        &file
                            .as_ref()
                            .ok_or(PoolNominationError::Refused("POOL_RETIRE_FILE_CLOSED"))?
                            .metadata()?,
                    )) == *stamp,
                    "POOL_RETIRE_POLICY_CHANGED",
                )?;
            }
        }
        if !self.archived {
            return Ok(());
        }
        for name in ["policies", "control"] {
            match fs::symlink_metadata(self.root.join(name)) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()),
                Ok(_) => {
                    return Err(PoolNominationError::Refused(
                        "POOL_RETIRE_NAMESPACE_RECREATED",
                    ));
                }
            }
        }
        Ok(())
    }
    pub(super) fn close(&mut self) -> Result<()> {
        if let Some(error) = &self.close_error {
            return Err(PoolNominationError::Refused(error.code()));
        }
        if self.closed {
            return Ok(());
        }
        need(!self.close_attempted, "POOL_RETIRE_CLOSE_UNCONFIRMED")?;
        self.close_attempted = true;
        let mut result = Ok(());
        for (_, file, _, _) in &mut self.files {
            let closed = file
                .take()
                .map_or(Ok(()), |f| native::close(f).map_err(Into::into));
            result = finalized(result, closed);
        }
        for (file, _) in &mut self.directories {
            let closed = file
                .take()
                .map_or(Ok(()), |f| native::close(f).map_err(Into::into));
            result = finalized(result, closed);
        }
        match result {
            Ok(()) => {
                self.closed = true;
                Ok(())
            }
            Err(error) => {
                let code = error.code();
                self.close_error = Some(Box::new(error));
                Err(PoolNominationError::Refused(code))
            }
        }
    }
}
