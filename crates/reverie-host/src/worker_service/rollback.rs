//! Happy-path code-generation rollback. This never clears an unknown attempt,
//! running native owner, resource journal, or configuration transition.
use super::*;
impl State {
    pub(super) fn rollback(&mut self, observed: ObservedUnit, start_previous: bool) -> Result<()> {
        self.assert_installed(&observed)?;
        observed.require_action_finished(&WorkerServiceAction::Stop)?;
        self.assert_rollback_quiescent()?;
        self.assert_legacy_selection()?;
        let stored = self.read_private(&self.folder().join("source-sha256"))?;
        need(
            stored == self.source_digest()?,
            "NATIVE_SERVICE_ROLLBACK_SOURCE_CHANGED",
        )?;
        let previous = self.previous.clone().ok_or(WorkerServiceError::Refused(
            "NATIVE_SERVICE_PREDECESSOR_NOT_PACKAGED",
        ))?;
        let backup = self.folder().join("previous-unit");
        let m = fs::symlink_metadata(&backup)?;
        need(
            m.file_type().is_symlink()
                && m.uid() == nix::unistd::geteuid().as_raw()
                && m.nlink() == 1
                && fs::read_link(&backup)? == previous,
            "NATIVE_SERVICE_ROLLBACK_PREDECESSOR_CHANGED",
        )?;
        let recorded = self.read_private(&self.folder().join("previous-generation"))?;
        need(
            recorded.as_bytes() == previous.as_os_str().as_encoded_bytes(),
            "NATIVE_SERVICE_ROLLBACK_PREDECESSOR_CHANGED",
        )?;
        for name in ["rolled-back-native-unit", "rolled-back-native-environment"] {
            absent(
                &self.folder().join(name),
                "NATIVE_SERVICE_ROLLBACK_HISTORY_COLLISION",
            )?;
        }
        self.begin_attempt(&WorkerServiceAction::Rollback { start_previous })?;
        self.restore_generation()?;
        // No start/reload occurs while an original filesystem close remains unknown.
        self.close_metadata()?;
        self.command(&["daemon-reload"])?;
        let current = self.observe()?;
        need(
            current.fragment == previous,
            "NATIVE_SERVICE_ROLLBACK_GENERATION_UNCONFIRMED",
        )?;
        self.assert_stoppable(&current)?;
        current.require_action_finished(&WorkerServiceAction::Stop)?;
        self.close_metadata()?;
        if start_previous {
            self.command(&["start", UNIT])?;
            let current = self.observe()?;
            need(
                current.fragment == previous,
                "NATIVE_SERVICE_ROLLBACK_GENERATION_UNCONFIRMED",
            )?;
            self.assert_stoppable(&current)?;
            current.require_action_finished(&WorkerServiceAction::Start)?;
        }
        Ok(())
    }
    fn restore_generation(&mut self) -> Result<()> {
        let units = self.home.join(".config/systemd/user");
        let m = fs::symlink_metadata(&units)?;
        need(
            m.is_dir() && m.uid() == nix::unistd::geteuid().as_raw() && m.mode() & 0o022 == 0,
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
        self.attempted = true;
        native::retain_native_service_unit(&self.files[unit], &self.files[folder])?;
        native::retain_native_service_environment(&self.files[folder])?;
        native::restore_previous_service_unit(&self.files[folder], &self.files[unit])?;
        let unit_synced = self.files[unit].sync_all().map_err(WorkerServiceError::Io);
        let folder_synced = self.files[folder]
            .sync_all()
            .map_err(WorkerServiceError::Io);
        finalized(unit_synced, folder_synced)
    }
    fn assert_rollback_quiescent(&self) -> Result<()> {
        for name in ["native-running", "native-failure", "pending"] {
            absent(
                &self.folder().join(name),
                "NATIVE_SERVICE_ROLLBACK_REQUIRES_QUIESCENCE",
            )?;
        }
        Ok(())
    }
}
fn absent(path: &Path, code: &'static str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => Err(WorkerServiceError::Refused(code)),
    }
}
