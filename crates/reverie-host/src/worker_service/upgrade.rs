//! Recorded-native to packaged-native code replacement. The original image,
//! source, R state and initial predecessor records are never rewritten.
use super::*;
use reverie_contracts::worker_pool::BrokerProgramData;
use std::io::Read;
use stopped::bus::{BusReader, ExpectedCommands, ServiceGroupData};
mod stop_pending;
pub(super) use stop_pending::StopPendingTakeover;

/// Present only after the actual immutable program/unit and original owned
/// selection were checked. No caller or wire constructor is exposed.
pub(super) struct CheckedNativeGeneration {
    pub(super) unit: PathBuf,
    body: String,
}
impl State {
    pub(super) fn prepare_recorded_generation(&mut self) -> Result<()> {
        let unit = self.recorded_native_link()?;
        let body = self.verify_native_recipe(&unit)?;
        self.checked_generation = Some(CheckedNativeGeneration { unit, body });
        Ok(())
    }
    pub(super) fn upgrade(&mut self, observed: ObservedUnit, force: bool) -> Result<()> {
        let old = self.recorded_native(&observed)?;
        let checked = self
            .checked_generation
            .as_ref()
            .ok_or(WorkerServiceError::Refused(
                "NATIVE_SERVICE_UPGRADE_GENERATION_UNCHECKED",
            ))?;
        need(
            checked.unit == old,
            "NATIVE_SERVICE_UPGRADE_GENERATION_CHANGED",
        )?;
        let old_body = checked.body.clone();
        self.verify_native_recipe(&self.unit.clone())?;
        need(old != self.unit, "NATIVE_SERVICE_UPGRADE_ALREADY_SELECTED")?;
        let source = self.source_snapshot()?;
        let expected = ExpectedCommands::capture(&old_body, &self.home)?;
        self.upgrade_bus = Some(BusReader::capture(self)?);
        self.close_metadata()?;
        let retained_stop = if force {
            self.take_over_stopped_pending(&old, &expected, &source)?
        } else {
            None
        };
        self.begin_attempt(&WorkerServiceAction::Upgrade {
            force_stopped: force,
        })?;
        self.attempted = true;
        // systemd stop is a no-op for an already failed service. Preserve its
        // last invocation and require the independent force quiescence proof.
        if !(force && observed.active == "failed") {
            self.command(&["stop", UNIT])?;
        }
        self.assert_upgrade_stopped(&old, &expected, force)?;
        if !force {
            self.assert_no_native_actor()?;
        }
        let group = if force {
            Some(self.force_stopped_group()?)
        } else {
            None
        };
        let history = match retained_stop {
            Some(history) => history,
            None => self.upgrade_history(&old, &source.digest, force)?,
        };
        self.pin_package_at(&history.join("gcroot"))?;
        self.assert_upgrade_stopped(&old, &expected, force)?;
        if let Some(group) = &group {
            self.assert_force_group_current(group)?;
            self.archive_old_markers(&history)?;
        }
        self.assert_no_native_actor()?;
        self.replace_native_links(&history, &old)?;
        need(
            self.source_snapshot()?.raw == source.raw,
            "NATIVE_SERVICE_UPGRADE_SOURCE_CHANGED",
        )?;
        self.close_metadata()?;
        self.command(&["daemon-reload"])?;
        let selected = self.observe()?;
        self.assert_installed(&selected)?;
        selected.require_action_finished(&WorkerServiceAction::Upgrade {
            force_stopped: force,
        })?;
        if let Some(group) = &group {
            self.assert_force_group_current(group)?;
        }
        self.assert_no_native_actor()?;
        need(
            self.source_snapshot()?.raw == source.raw,
            "NATIVE_SERVICE_UPGRADE_SOURCE_CHANGED",
        )
    }
    fn recorded_native(&mut self, observed: &ObservedUnit) -> Result<PathBuf> {
        need(
            observed.load == "loaded",
            "NATIVE_SERVICE_UPGRADE_REQUIRES_NATIVE",
        )?;
        let old = self.recorded_native_link()?;
        need(
            observed.fragment == old,
            "NATIVE_SERVICE_UPGRADE_GENERATION_CHANGED",
        )?;
        Ok(old)
    }
    fn recorded_native_link(&mut self) -> Result<PathBuf> {
        let link = self.folder().join("native-package");
        let m = fs::symlink_metadata(&link)?;
        need(
            m.file_type().is_symlink()
                && m.uid() == nix::unistd::geteuid().as_raw()
                && m.nlink() == 1,
            "NATIVE_SERVICE_UPGRADE_RECORD_CHANGED",
        )?;
        let old = fs::read_link(link)?;
        need(
            self.selected_unit_link()? == old,
            "NATIVE_SERVICE_UPGRADE_GENERATION_CHANGED",
        )?;
        need(
            self.read_private(&self.folder().join("environment"))? == environment(&self.source)?,
            "NATIVE_SERVICE_UPGRADE_SOURCE_CHANGED",
        )?;
        // Verify the original installation records remain owned and present.
        for name in [
            "previous-generation",
            "source-original.json",
            "source-sha256",
        ] {
            self.read_private(&self.folder().join(name))?;
        }
        Ok(old)
    }
    fn verify_native_recipe(&mut self, unit: &Path) -> Result<String> {
        let package = unit.ancestors().nth(4).ok_or(WorkerServiceError::Refused(
            "NATIVE_SERVICE_UPGRADE_PACKAGE",
        ))?;
        let role = [
            NativeWorkerServiceRole::Broker,
            NativeWorkerServiceRole::PoolOfferV1,
        ]
        .into_iter()
        .find(|role| unit == package.join(role.unit_relative_path()))
        .ok_or(WorkerServiceError::Refused(
            "NATIVE_SERVICE_UPGRADE_PACKAGE",
        ))?;
        let raw = self.read_immutable(&package.join("share/reverie/worker-broker-program.json"))?;
        let selected = BrokerProgramData::decode(raw.as_bytes())
            .map_err(|_| WorkerServiceError::Refused("NATIVE_SERVICE_UPGRADE_PROGRAM"))?;
        let executable = selected
            .code()
            .path
            .as_text_ref()
            .scalar_text()
            .ok_or(WorkerServiceError::Refused(
                "NATIVE_SERVICE_UPGRADE_PROGRAM",
            ))?
            .into_owned();
        need(
            Path::new(&executable) == package.join("bin/reverie-worker-broker"),
            "NATIVE_SERVICE_UPGRADE_PROGRAM",
        )?;
        let observed = self
            .upgrade_inputs
            .observe_broker_program(&selected, self.end);
        observed.map_err(|e| self.retain_program_error(e))?;
        let body = self.read_immutable(unit)?;
        need(
            body == reverie_contracts::worker_service::native_unit_for_role(&executable, role),
            "NATIVE_SERVICE_UPGRADE_UNIT_RECIPE",
        )?;
        Ok(body)
    }
    pub(super) fn retain_program_error(
        &mut self,
        error: crate::website_facts::WebsiteFactsError,
    ) -> WorkerServiceError {
        let code = self
            .upgrade_failure
            .as_ref()
            .map_or(error.code(), |first| first.code());
        self.upgrade_failure = Some(match self.upgrade_failure.take() {
            None => Box::new(error),
            Some(primary) => Box::new(crate::website_facts::WebsiteFactsError::Finalization {
                primary,
                secondary: Box::new(error),
            }),
        });
        WorkerServiceError::Program(code)
    }
    fn assert_upgrade_stopped(
        &mut self,
        old: &Path,
        expected: &ExpectedCommands,
        force: bool,
    ) -> Result<()> {
        let before = self.observe()?;
        need(
            before.fragment == old && self.selected_unit_link()? == old,
            "NATIVE_SERVICE_UPGRADE_GENERATION_CHANGED",
        )?;
        need(
            self.read_private(&self.folder().join("environment"))? == environment(&self.source)?,
            "NATIVE_SERVICE_UPGRADE_SOURCE_CHANGED",
        )?;
        before.require_action_finished(&WorkerServiceAction::Upgrade {
            force_stopped: force,
        })?;
        self.upgrade_bus
            .as_mut()
            .expect("retained original bus")
            .verify(expected)?;
        let after = self.observe()?;
        need(
            after.fragment == old,
            "NATIVE_SERVICE_UPGRADE_GENERATION_CHANGED",
        )?;
        after.require_action_finished(&WorkerServiceAction::Upgrade {
            force_stopped: force,
        })
    }
    fn upgrade_history(&mut self, old: &Path, digest: &str, force: bool) -> Result<PathBuf> {
        let base = self.folder().join("upgrades");
        fs::DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(&base)?;
        private(&base, true)?;
        let history = base.join(
            crate::resource_facts::fresh_owner_nonce()
                .map_err(|e| WorkerServiceError::Io(std::io::Error::other(e)))?
                .as_str(),
        );
        fs::DirBuilder::new().mode(0o700).create(&history)?;
        self.exclusive(
            &history.join("from-unit"),
            old.as_os_str().as_encoded_bytes(),
        )?;
        self.exclusive(
            &history.join("to-unit"),
            self.unit.clone().as_os_str().as_encoded_bytes(),
        )?;
        self.exclusive(&history.join("source-sha256"), digest.as_bytes())?;
        self.exclusive(
            &history.join("force-stopped"),
            if force { b"true\n" } else { b"false\n" },
        )?;
        let index = self.open_directory(&base)?;
        self.files[index].sync_all()?;
        let index = self.open_directory(&history)?;
        self.files[index].sync_all()?;
        Ok(history)
    }
    pub(super) fn replace_native_links(&mut self, history: &Path, old: &Path) -> Result<()> {
        need(
            self.marker && !self.uncertain,
            "NATIVE_SERVICE_ORIGINAL_ATTEMPT_RETAINED",
        )?;
        need(
            self.selected_unit_link()? == old
                && fs::read_link(self.folder().join("native-package"))? == old,
            "NATIVE_SERVICE_UPGRADE_GENERATION_CHANGED",
        )?;
        let units = self.home.join(".config/systemd/user");
        let info = fs::symlink_metadata(&units)?;
        need(
            info.is_dir()
                && info.uid() == nix::unistd::geteuid().as_raw()
                && info.mode() & 0o022 == 0,
            "NATIVE_SERVICE_UNIT_DIRECTORY_CUSTODY",
        )?;
        let unit = native::open_at(
            libc::AT_FDCWD,
            units.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        self.files.push(unit);
        let unit = self.files.len() - 1;
        let folder = self.open_directory(&self.folder())?;
        let target = self.open_directory(history)?;
        native::retain_predecessor(&self.files[unit], &self.files[target])?;
        native::retain_upgrade_package(&self.files[folder], &self.files[target])?;
        std::os::unix::fs::symlink(&self.unit, units.join(UNIT))?;
        std::os::unix::fs::symlink(&self.unit, self.folder().join("native-package"))?;
        for index in [unit, folder, target] {
            self.files[index].sync_all()?;
        }
        need(
            self.selected_unit_link()? == self.unit
                && fs::read_link(self.folder().join("native-package"))? == self.unit,
            "NATIVE_SERVICE_UPGRADE_PUBLICATION_CHANGED",
        )
    }
    pub(super) fn archive_old_markers(&mut self, history: &Path) -> Result<()> {
        let source = self.open_directory(&self.folder())?;
        let target = self.open_directory(history)?;
        for failure in [false, true] {
            let name = if failure {
                "native-failure"
            } else {
                "native-running"
            };
            match fs::symlink_metadata(self.folder().join(name)) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
                Ok(_) => private(&self.folder().join(name), false)?,
            }
            if failure {
                native::retain_upgrade_failure(&self.files[source], &self.files[target])?;
            } else {
                native::retain_upgrade_running(&self.files[source], &self.files[target])?;
            }
        }
        self.files[source].sync_all()?;
        self.files[target].sync_all()?;
        Ok(())
    }
    fn force_stopped_group(&mut self) -> Result<ServiceGroupData> {
        let group = self
            .upgrade_bus
            .as_mut()
            .expect("original bus")
            .stopped_group()?;
        self.assert_force_group_current(&group)?;
        Ok(group)
    }
    pub(super) fn assert_force_group_current(&mut self, expected: &ServiceGroupData) -> Result<()> {
        let current = self
            .upgrade_bus
            .as_mut()
            .expect("original bus")
            .stopped_group()?;
        need(
            current == *expected && current.pid > 0,
            "NATIVE_SERVICE_FORCE_ORIGINAL_PROCESS_REQUIRED",
        )?;
        need(
            fs::symlink_metadata(format!("/proc/{}", current.pid))
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
            "NATIVE_SERVICE_FORCE_OLD_PROCESS_EXISTS",
        )?;
        let slice = kernel_slice(&current.group, &current.slice)?;
        let slice_file = native::open_at(
            libc::AT_FDCWD,
            slice.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        self.files.push(slice_file);
        let slice_index = self.files.len() - 1;
        let slice_before = self.files[slice_index].metadata()?;
        need(
            nix::sys::statfs::fstatfs(&self.files[slice_index])
                .map_err(std::io::Error::from)?
                .filesystem_type()
                == nix::sys::statfs::CGROUP2_SUPER_MAGIC,
            "NATIVE_SERVICE_FORCE_CGROUP_FILESYSTEM",
        )?;
        let control = self
            .upgrade_bus
            .as_mut()
            .expect("original bus")
            .control_group()?;
        let child = slice.join(UNIT);
        let relative = child.strip_prefix("/sys/fs/cgroup").expect("fixed root");
        need(
            control.is_empty() || Path::new(&control) == Path::new("/").join(relative),
            "NATIVE_SERVICE_FORCE_CGROUP_CHANGED",
        )?;
        self.assert_empty_service_group(&child)?;
        let slice_after = fs::symlink_metadata(&slice)?;
        need(
            slice_before.dev() == slice_after.dev() && slice_before.ino() == slice_after.ino(),
            "NATIVE_SERVICE_FORCE_SLICE_CHANGED",
        )?;
        need(
            self.upgrade_bus
                .as_mut()
                .expect("original bus")
                .stopped_group()?
                == *expected,
            "NATIVE_SERVICE_FORCE_CGROUP_CHANGED",
        )
    }
    fn assert_empty_service_group(&mut self, child: &Path) -> Result<()> {
        match fs::symlink_metadata(child) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
            Ok(info) => {
                need(info.is_dir(), "NATIVE_SERVICE_FORCE_CGROUP_CHANGED")?;
                let events = self.read_cgroup_file(&child.join("cgroup.events"))?;
                need(
                    reverie_contracts::kernel_accounting::old_cgroup_unpopulated(&events).map_err(
                        |_| WorkerServiceError::Refused("NATIVE_SERVICE_FORCE_CGROUP_EVENTS"),
                    )?,
                    "NATIVE_SERVICE_FORCE_CGROUP_POPULATED",
                )?;
                need(
                    self.read_cgroup_file(&child.join("cgroup.procs"))?
                        .trim()
                        .is_empty(),
                    "NATIVE_SERVICE_FORCE_CGROUP_POPULATED",
                )?;
                let after = fs::symlink_metadata(child)?;
                need(
                    info.dev() == after.dev() && info.ino() == after.ino(),
                    "NATIVE_SERVICE_FORCE_CGROUP_CHANGED",
                )?;
            }
        }
        Ok(())
    }
    fn read_cgroup_file(&mut self, path: &Path) -> Result<String> {
        let file = native::open_at(
            libc::AT_FDCWD,
            path.as_os_str(),
            libc::O_RDONLY | libc::O_NONBLOCK,
        )?;
        self.files.push(file);
        let file = self.files.last_mut().expect("retain before read");
        need(
            nix::sys::statfs::fstatfs(&*file)
                .map_err(std::io::Error::from)?
                .filesystem_type()
                == nix::sys::statfs::CGROUP2_SUPER_MAGIC,
            "NATIVE_SERVICE_FORCE_CGROUP_FILESYSTEM",
        )?;
        let mut raw = String::new();
        file.take(4097).read_to_string(&mut raw)?;
        need(raw.len() <= 4096, "NATIVE_SERVICE_FORCE_CGROUP_BOUND")?;
        Ok(raw)
    }
}
fn kernel_slice(group: &str, slice: &str) -> Result<PathBuf> {
    use std::path::Component;
    let path = Path::new(group);
    need(
        path.is_absolute()
            && path.file_name() == Some(std::ffi::OsStr::new(slice))
            && path
                .components()
                .all(|p| matches!(p, Component::RootDir | Component::Normal(_))),
        "NATIVE_SERVICE_FORCE_SLICE_GROUP",
    )?;
    let path = Path::new("/sys/fs/cgroup").join(path.strip_prefix("/").expect("absolute"));
    reverie_store::storage_identity::canonical(&path)
        .map_err(|e| WorkerServiceError::Io(std::io::Error::other(e)))?;
    Ok(path)
}
