//! The fixed native process leaves a durable fence before its first startup
//! effect. Only its same successful service run clears the original inode.
use super::*;
pub struct NativeServiceRunAttempt {
    path: PathBuf,
    file: Option<File>,
    parent: Option<File>,
    identity: Option<(u64, u64)>,
}
pub struct NativeServiceRunFailure {
    owner: Option<Box<NativeServiceRunAttempt>>,
    primary: WorkerServiceError,
}
impl std::fmt::Debug for NativeServiceRunFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeServiceRunFailure")
            .field("primary", &self.primary)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for NativeServiceRunFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.primary.fmt(f)
    }
}
impl std::error::Error for NativeServiceRunFailure {}
impl Drop for NativeServiceRunFailure {
    fn drop(&mut self) {
        std::mem::forget(self.owner.take());
    }
}
impl Drop for NativeServiceRunAttempt {
    fn drop(&mut self) {
        std::mem::forget((self.file.take(), self.parent.take()));
    }
}
impl NativeServiceRunAttempt {
    fn unopened(path: PathBuf) -> Self {
        Self {
            path,
            file: None,
            parent: None,
            identity: None,
        }
    }
    fn begin(&mut self) -> Result<()> {
        let folder = self.path.parent().expect("fixed run parent");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(folder)?;
        private(folder, true)?;
        self.parent = Some(native::open_at(
            libc::AT_FDCWD,
            folder.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?);
        self.file = Some(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&self.path)?,
        );
        let file = self.file.as_mut().expect("retained before write");
        let m = file.metadata()?;
        self.identity = Some((m.dev(), m.ino()));
        file.write_all(b"NATIVE_SERVICE_RUNNING_OR_UNSETTLED_V1\n")?;
        file.sync_all()?;
        self.parent.as_ref().expect("retained parent").sync_all()?;
        Ok(())
    }
    pub fn finish_known(mut self) -> std::result::Result<(), Box<NativeServiceRunFailure>> {
        let result = self.finish();
        match result {
            Ok(()) => Ok(()),
            Err(primary) => Err(Box::new(NativeServiceRunFailure {
                owner: Some(Box::new(self)),
                primary,
            })),
        }
    }
    fn finish(&mut self) -> Result<()> {
        let m = fs::symlink_metadata(&self.path)?;
        need(
            self.identity == Some((m.dev(), m.ino())) && m.is_file() && m.nlink() == 1,
            "NATIVE_SERVICE_RUN_FENCE_CHANGED",
        )?;
        fs::remove_file(&self.path)?;
        self.parent.as_ref().expect("retained parent").sync_all()?;
        let file = self
            .file
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(|e| WorkerServiceError::Io(std::io::Error::other(e)));
        let parent = self
            .parent
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(|e| WorkerServiceError::Io(std::io::Error::other(e)));
        finalized(file, parent)
    }
}
pub fn begin_service_run(
    source: &Path,
) -> std::result::Result<NativeServiceRunAttempt, Box<NativeServiceRunFailure>> {
    let path = match super::failure_fence::path(source) {
        Ok(path) => path.with_file_name("native-running"),
        Err(primary) => {
            return Err(Box::new(NativeServiceRunFailure {
                owner: None,
                primary,
            }));
        }
    };
    let mut owner = NativeServiceRunAttempt::unopened(path);
    match owner.begin() {
        Ok(()) => Ok(owner),
        Err(primary) => Err(Box::new(NativeServiceRunFailure {
            owner: Some(Box::new(owner)),
            primary,
        })),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persisted_original_fence_refuses_second_process_before_effects() {
        let root = std::env::temp_dir().join(format!(
            "native-run-fence-{}-{}",
            std::process::id(),
            crate::resource_facts::fresh_owner_nonce().unwrap().as_str()
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let path = root.join("native-running");
        let mut first = NativeServiceRunAttempt::unopened(path.clone());
        first.begin().unwrap();
        let mut next = NativeServiceRunAttempt::unopened(path.clone());
        assert!(
            matches!(next.begin(),Err(WorkerServiceError::Io(error)) if error.kind()==std::io::ErrorKind::AlreadyExists)
        );
        assert_eq!(
            fs::read(&path).unwrap(),
            b"NATIVE_SERVICE_RUNNING_OR_UNSETTLED_V1\n"
        );
        // The refused second attempt owns only its opened parent, which is checked
        // closed; it never removes the first process's marker.
        native::close(next.parent.take().unwrap()).unwrap();
        first.finish_known().unwrap();
        assert!(!path.exists());
        fs::remove_dir(root).unwrap();
    }
}
