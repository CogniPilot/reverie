use super::*;
pub(super) fn environment(source: &Path) -> Result<String> {
    let text = source
        .to_str()
        .ok_or(WorkerServiceError::Refused("NATIVE_SERVICE_SOURCE_UTF8"))?;
    need(
        source.is_absolute() && !text.chars().any(|c| c.is_control()),
        "NATIVE_SERVICE_SOURCE_REQUIRED",
    )?;
    Ok(format!(
        "REVERIE_WORKER_CONFIG=\"{}\"\n",
        text.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}
impl State {
    pub(super) fn read_private(&mut self, path: &Path) -> Result<String> {
        use std::io::Read;
        private(path, false)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        self.files.push(file);
        let mut raw = String::new();
        self.files
            .last_mut()
            .expect("retained before read")
            .take(65537)
            .read_to_string(&mut raw)?;
        need(raw.len() <= 65536, "NATIVE_SERVICE_SELECTION_BOUND")?;
        Ok(raw)
    }
    pub(super) fn folder(&self) -> PathBuf {
        self.root.join("worker-pool/service")
    }
    fn open_directory(&mut self, path: &Path) -> Result<usize> {
        private(path, true)?;
        let f = native::open_at(
            libc::AT_FDCWD,
            path.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        self.files.push(f);
        Ok(self.files.len() - 1)
    }
    fn exclusive(&mut self, path: &Path, bytes: &[u8]) -> Result<()> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        self.files.push(file);
        let file = self.files.last_mut().expect("retained before write");
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    }
    pub(super) fn begin_attempt(&mut self) -> Result<()> {
        let folder = self.folder();
        private(&folder, true)?;
        self.exclusive(
            &folder.join("pending"),
            b"NATIVE_SERVICE_ORIGINAL_ATTEMPT_V1\n",
        )?;
        let n = self.open_directory(&folder)?;
        self.files[n].sync_all()?;
        self.marker = true;
        Ok(())
    }
    pub(super) fn finish_attempt(&mut self) -> Result<()> {
        need(
            self.marker && !self.uncertain,
            "NATIVE_SERVICE_ORIGINAL_ATTEMPT_RETAINED",
        )?;
        fs::remove_file(self.folder().join("pending"))?;
        let folder = self.folder();
        let n = self.open_directory(&folder)?;
        self.files[n].sync_all()?;
        self.marker = false;
        Ok(())
    }
    pub(super) fn install(&mut self, observed: ObservedUnit) -> Result<()> {
        observed.require_replaceable(self.previous.as_deref())?;
        private(&self.root, true)?;
        let folder = self.folder();
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&folder)?;
        private(&folder, true)?;
        let units = self.home.join(".config/systemd/user");
        owned_unit_directory(&units)?;
        let link = units.join(UNIT);
        if observed.load == "loaded" {
            need(
                fs::read_link(&link)? == observed.fragment,
                "NATIVE_SERVICE_PREDECESSOR_CHANGED",
            )?;
        } else {
            need(
                fs::symlink_metadata(&link)
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
                "NATIVE_SERVICE_UNREGISTERED_UNIT_EXISTS",
            )?;
        }
        self.begin_attempt()?;
        self.pin_package()?;
        // Preserve the original exact predecessor and selection; no overwrite.
        self.exclusive(
            &folder.join("previous-generation"),
            observed.fragment.as_os_str().as_encoded_bytes(),
        )?;
        self.exclusive(
            &folder.join("environment"),
            environment(&self.source)?.as_bytes(),
        )?;
        if observed.load == "loaded" {
            let old_environment = self.home.join(".config/reverie/worker-broker.env");
            need(
                self.read_private(&old_environment)? == environment(&self.source)?,
                "NATIVE_SERVICE_PREDECESSOR_SOURCE_CHANGED",
            )?;
            fs::rename(&link, folder.join("previous-unit"))?;
        }
        std::os::unix::fs::symlink(&self.unit, &link)?;
        std::os::unix::fs::symlink(&self.unit, folder.join("native-package"))?;
        let file = native::open_at(
            libc::AT_FDCWD,
            units.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        self.files.push(file);
        self.files.last().expect("unitdir retained").sync_all()?;
        let n = self.open_directory(&folder)?;
        self.files[n].sync_all()?;
        self.attempted = true;
        self.command(&["daemon-reload"])?;
        let observed = self.observe()?;
        self.assert_installed(&observed)?;
        self.finish_attempt()
    }
}

fn owned_unit_directory(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    need(
        m.is_dir() && m.uid() == nix::unistd::geteuid().as_raw() && m.mode() & 0o022 == 0,
        "NATIVE_SERVICE_UNIT_DIRECTORY_CUSTODY",
    )
}
