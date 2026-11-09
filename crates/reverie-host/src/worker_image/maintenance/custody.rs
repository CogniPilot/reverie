use super::*;
use reverie_contracts::{
    worker_image_switch::DeploymentCompanyData, worker_launch::LaunchSettings,
};
use std::{collections::BTreeSet, ffi::OsStr, os::fd::AsRawFd};
type Identity = (u64, u64, u32, u32, u32);
fn identity(m: &fs::Metadata) -> Identity {
    (m.dev(), m.ino(), m.mode(), m.uid(), m.gid())
}
pub(super) struct Directory {
    path: PathBuf,
    file: Option<File>,
    stamp: Option<Identity>,
}
pub(super) struct HeldLock {
    path: PathBuf,
    file: Option<File>,
    stamp: Option<ImageFileStamp>,
    locked: bool,
}
pub(super) struct Terminal {
    end: Instant,
    owner_terminal: PathBuf,
    deployment: (PathBuf, ImageFileStamp),
    directories: Vec<(PathBuf, Identity)>,
    locks: Vec<(PathBuf, ImageFileStamp)>,
}
impl Terminal {
    pub(super) fn current(&self) -> Result<()> {
        require(
            Instant::now() < self.end,
            "WORKER_IMAGE_MAINTENANCE_DEADLINE",
        )?;
        owner_terminal_absent(&self.owner_terminal)?;
        require(
            ImageFileStamp::observe(&self.deployment.0)? == self.deployment.1,
            "WORKER_IMAGE_DEPLOYMENT_CHANGED",
        )?;
        for (path, stamp) in &self.directories {
            require(
                identity(&fs::symlink_metadata(path).map_err(ImageFileError::io)?) == *stamp,
                "WORKER_IMAGE_MAINTENANCE_PARENT_CHANGED",
            )?;
        }
        for (path, stamp) in &self.locks {
            require(
                ImageFileStamp::observe(path)? == *stamp,
                "WORKER_IMAGE_MAINTENANCE_LOCK_CHANGED",
            )?;
        }
        Ok(())
    }
}
impl Directory {
    fn current(&self) -> Result<()> {
        let file = self
            .file
            .as_ref()
            .ok_or_else(|| ImageFileError::refused("WORKER_IMAGE_MAINTENANCE_CLOSED"))?;
        require(
            self.stamp == Some(identity(&file.metadata().map_err(ImageFileError::io)?))
                && self.stamp
                    == Some(identity(
                        &fs::symlink_metadata(&self.path).map_err(ImageFileError::io)?,
                    )),
            "WORKER_IMAGE_MAINTENANCE_PARENT_CHANGED",
        )
    }
    pub(super) fn close(&mut self) -> Result<()> {
        self.file
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(ImageFileError::native)
    }
}
impl HeldLock {
    fn current(&self) -> Result<()> {
        let file = self
            .file
            .as_ref()
            .ok_or_else(|| ImageFileError::refused("WORKER_IMAGE_MAINTENANCE_CLOSED"))?;
        require(
            self.locked
                && self.stamp.as_ref()
                    == Some(&ImageFileStamp::of(
                        &file.metadata().map_err(ImageFileError::io)?,
                    ))
                && self.stamp.as_ref() == Some(&ImageFileStamp::observe(&self.path)?),
            "WORKER_IMAGE_MAINTENANCE_LOCK_CHANGED",
        )
    }
    pub(super) fn close(&mut self) -> Result<()> {
        self.file
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(ImageFileError::native)
    }
}
impl Owner {
    fn owner_terminal(&self) -> Result<PathBuf> {
        Ok(self
            .root
            .parent()
            .ok_or_else(|| ImageFileError::refused("WORKER_IMAGE_REGISTERED_HOME"))?
            .join(".config/systemd/user/reverie-owner-terminal.service"))
    }
    pub(super) fn terminal(&self) -> Result<Terminal> {
        self.current()?;
        Ok(Terminal {
            end: self.end,
            owner_terminal: self.owner_terminal()?,
            deployment: self.deployment.clone().expect("same actual deployment"),
            directories: self
                .directories
                .iter()
                .map(|directory| {
                    (
                        directory.path.clone(),
                        directory.stamp.expect("qualified parent"),
                    )
                })
                .collect(),
            locks: self
                .locks
                .iter()
                .map(|lock| {
                    (
                        lock.path.clone(),
                        lock.stamp.clone().expect("qualified lock"),
                    )
                })
                .collect(),
        })
    }
    fn time(&self) -> Result<()> {
        require(
            Instant::now() < self.end,
            "WORKER_IMAGE_MAINTENANCE_DEADLINE",
        )
    }
    pub(super) fn acquire(&mut self, config: &EffectiveWorkerConfig) -> Result<()> {
        self.time()?;
        owner_terminal_absent(&self.owner_terminal()?)?;
        let captured = ReservationConfiguration::capture(config.clone());
        require(
            captured.uid().map_err(ImageFileError::configuration)? == self.uid
                && self.source.starts_with(&self.root),
            "WORKER_IMAGE_MAINTENANCE_SOURCE",
        )?;
        let deployment = self.root.join("deployment.json");
        reverie_store::storage_identity::canonical(&self.source)
            .map_err(ImageFileError::identity)?;
        reverie_store::storage_identity::canonical(&deployment)
            .map_err(ImageFileError::identity)?;
        let before = self.reader.read_configuration()?;
        let source = reverie_contracts::worker_config::decode(before.bytes())
            .map_err(|_| ImageFileError::refused("WORKER_IMAGE_MAINTENANCE_SOURCE"))?;
        require(
            reverie_contracts::worker_config::equivalent(&source, config),
            "WORKER_IMAGE_MAINTENANCE_SOURCE",
        )?;
        let selected = self.reader.read(&deployment)?;
        let data = DeploymentCompanyData::capture(selected.metadata())
            .map_err(ImageFileError::transition)?;
        self.deployment = Some((deployment.clone(), selected.stamp().clone()));
        let company =
            native::python_path(data.company_root().codepoints()).map_err(ImageFileError::io)?;
        let settings = LaunchSettings::capture(config)
            .map_err(|_| ImageFileError::refused("WORKER_IMAGE_DEPLOYMENT_BINDING"))?;
        require(
            data.container_name()
                == captured
                    .server_container()
                    .map_err(ImageFileError::configuration)?
                && native::python_path(settings.company_root().codepoints())
                    .map_err(ImageFileError::io)?
                    == company.join("data")
                && native::python_path(settings.company_file().codepoints())
                    .map_err(ImageFileError::io)?
                    == company.join("data/console/company.json"),
            "WORKER_IMAGE_DEPLOYMENT_BINDING",
        )?;
        let update = self.root.join("runtime/update-state/update.lock");
        self.parents(&[
            deployment,
            self.source.clone(),
            update.clone(),
            company.join("data/console/company.json"),
        ])?;
        for path in [
            &company,
            &company.join("data"),
            &company.join("data/console"),
            update.parent().expect("fixed update parent"),
            self.source.parent().expect("absolute source"),
        ] {
            let info = fs::symlink_metadata(path).map_err(ImageFileError::io)?;
            require(
                info.is_dir() && info.uid() == self.uid && info.mode() & 0o022 == 0,
                "WORKER_IMAGE_DEPLOYMENT_BINDING",
            )?;
        }
        self.binding_current()?;
        self.lock(&update, false)?;
        self.binding_current()?;
        self.lock(
            &self
                .source
                .parent()
                .expect("source parent")
                .join(".worker-image.lock"),
            true,
        )?;
        self.current()?;
        require(
            self.reader.read_configuration()?.bytes() == before.bytes(),
            "WORKER_IMAGE_MAINTENANCE_SOURCE",
        )?;
        self.current()
    }
    fn parents(&mut self, leaves: &[PathBuf]) -> Result<()> {
        let mut paths = BTreeSet::new();
        for leaf in leaves {
            reverie_store::storage_identity::canonical(leaf).map_err(ImageFileError::identity)?;
            paths.extend(leaf.ancestors().skip(1).map(Path::to_owned));
        }
        for path in paths {
            self.directory(path)?;
        }
        Ok(())
    }
    fn directory(&mut self, path: PathBuf) -> Result<()> {
        let file = native::open_at(
            libc::AT_FDCWD,
            path.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NONBLOCK,
        )
        .map_err(ImageFileError::io)?;
        self.directories.push(Directory {
            path,
            file: Some(file),
            stamp: None,
        });
        let directory = self.directories.last_mut().expect("stored before metadata");
        let info = directory
            .file
            .as_ref()
            .expect("held parent")
            .metadata()
            .map_err(ImageFileError::io)?;
        let sticky = info.uid() == 0 && info.mode() & libc::S_ISVTX != 0;
        require(
            info.is_dir()
                && (info.uid() == 0 || info.uid() == self.uid)
                && (info.mode() & 0o022 == 0 || sticky),
            "WORKER_IMAGE_MAINTENANCE_PARENT",
        )?;
        directory.stamp = Some(identity(&info));
        directory.current()
    }
    fn binding_current(&self) -> Result<()> {
        self.time()?;
        owner_terminal_absent(&self.owner_terminal()?)?;
        for directory in &self.directories {
            directory.current()?;
        }
        let (path, stamp) = self.deployment.as_ref().expect("original deployment");
        require(
            *stamp == ImageFileStamp::observe(path)?,
            "WORKER_IMAGE_DEPLOYMENT_CHANGED",
        )
    }
    fn lock(&mut self, path: &Path, create: bool) -> Result<()> {
        self.binding_current()?;
        let directory = self
            .directories
            .iter()
            .find(|d| Some(d.path.as_path()) == path.parent())
            .expect("captured exact lock parent");
        directory.current()?;
        let parent = directory.file.as_ref().expect("original parent");
        let flags = libc::O_RDWR | libc::O_NONBLOCK;
        let (file, created) = if create {
            match native::open_at_mode(
                parent.as_raw_fd(),
                OsStr::new(".worker-image.lock"),
                flags | libc::O_CREAT | libc::O_EXCL,
                0o600,
            ) {
                Ok(file) => (file, true),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (
                    native::open_at(parent.as_raw_fd(), OsStr::new(".worker-image.lock"), flags)
                        .map_err(ImageFileError::io)?,
                    false,
                ),
                Err(error) => return Err(ImageFileError::io(error)),
            }
        } else {
            (
                native::open_at(parent.as_raw_fd(), OsStr::new("update.lock"), flags)
                    .map_err(ImageFileError::io)?,
                false,
            )
        };
        self.locks.push(HeldLock {
            path: path.to_owned(),
            file: Some(file),
            stamp: None,
            locked: false,
        });
        let lock = self.locks.last_mut().expect("stored before metadata/flock");
        let file = lock.file.as_ref().expect("original lock");
        let info = file.metadata().map_err(ImageFileError::io)?;
        let stamp = ImageFileStamp::of(&info);
        require(
            stamp.stamp.private(self.uid) && (!create || info.len() == 0),
            "WORKER_IMAGE_MAINTENANCE_PRIVATE_LOCK",
        )?;
        lock.stamp = Some(stamp);
        native::memory_lock(file, true).map_err(ImageFileError::io)?;
        lock.locked = true;
        if created {
            file.sync_all().map_err(ImageFileError::io)?;
            parent.sync_all().map_err(ImageFileError::io)?;
        }
        lock.current()?;
        self.binding_current()
    }
    pub(super) fn current(&self) -> Result<()> {
        self.binding_current()?;
        require(
            self.locks.len() == 2,
            "WORKER_IMAGE_MAINTENANCE_LOCKS_REQUIRED",
        )?;
        for lock in &self.locks {
            lock.current()?;
        }
        self.binding_current()
    }
}
fn owner_terminal_absent(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ImageFileError::io(error)),
        Ok(_) => Err(ImageFileError::refused(
            "WORKER_IMAGE_OWNER_TERMINAL_UNSUPPORTED",
        )),
    }
}
