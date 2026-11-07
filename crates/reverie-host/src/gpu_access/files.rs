use super::*;
mod pending;
mod terminal;
#[cfg(test)]
mod tests;
pub use pending::GpuPendingFile;
use reverie_contracts::{
    gpu_access::{GpuTransitionIntent, MAX_BYTES, REQUEST_FILE, encode_requests},
    reservation_engine::ReservationConfiguration,
    storage_identity::OrderedMetadata,
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::gpu_access::GpuRequestDocument;
use reverie_store::storage_identity;
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File},
    io::Write,
    os::{fd::AsRawFd, unix::fs::PermissionsExt},
    path::{Path, PathBuf},
};
pub use terminal::{GpuParentGuard, GpuProtectedStores, GpuTerminalSnapshot};

/// Installing-service-selected source and fixed control paths. No request may
/// supply this source path; the actual application retains its validated loader
/// snapshot, admission and transition fence separately.
pub struct GpuControlFiles {
    source: Option<PathBuf>,
    config: ReservationConfiguration,
}
pub struct GpuPrivateSnapshot {
    metadata: OrderedMetadata,
    stamp: GpuFileStamp,
}
impl GpuPrivateSnapshot {
    pub fn metadata(&self) -> &OrderedMetadata {
        &self.metadata
    }
    pub fn stamp(&self) -> &GpuFileStamp {
        &self.stamp
    }
}
impl GpuControlFiles {
    pub fn capture(source: &Path, config: &EffectiveWorkerConfig) -> Self {
        Self {
            source: Some(source.to_owned()),
            config: ReservationConfiguration::capture(config.clone()),
        }
    }
    pub fn capture_control(config: &EffectiveWorkerConfig) -> Self {
        Self {
            source: None,
            config: ReservationConfiguration::capture(config.clone()),
        }
    }
    pub fn queue_present(&self) -> Result<bool> {
        Ok(fs::symlink_metadata(self.requests_path()?).is_ok())
    }
    fn source(&self) -> Result<&Path> {
        self.source
            .as_deref()
            .ok_or(GpuHostError::Refused("GPU_OWNER_CONTROL_UNAVAILABLE"))
    }
    pub fn read_configuration(&self) -> Result<GpuPrivateSnapshot> {
        self.read(self.source()?)
    }
    pub fn read_binding(&self) -> Result<GpuPrivateSnapshot> {
        self.read(&self.binding_path()?)
    }
    pub fn read_pending(&self) -> Result<GpuPrivateSnapshot> {
        self.read(&self.pending_path()?)
    }
    pub fn read_requests(&self) -> Result<Option<GpuPrivateSnapshot>> {
        let path = self.requests_path()?;
        if GpuFileStamp::observe_optional(&path)?.is_none() {
            return Ok(None);
        }
        self.read(&path).map(Some)
    }
    fn read(&self, path: &Path) -> Result<GpuPrivateSnapshot> {
        let stamp = GpuFileStamp::observe(path)?;
        need(stamp.private(self.config.uid()?), "GPU_PRIVATE_FILE")?;
        let metadata =
            storage_identity::read_ordered_metadata(path, self.config.uid()?, MAX_BYTES)?;
        need(
            GpuFileStamp::observe(path)? == stamp,
            "GPU_PRIVATE_FILE_CHANGED",
        )?;
        Ok(GpuPrivateSnapshot { metadata, stamp })
    }
    fn binding_path(&self) -> Result<PathBuf> {
        Ok(native::python_path(
            &self.config.control_paths()?.binding().codepoints(),
        )?)
    }
    fn pending_path(&self) -> Result<PathBuf> {
        Ok(native::python_path(
            &self.config.control_paths()?.pending().codepoints(),
        )?)
    }
    fn requests_path(&self) -> Result<PathBuf> {
        Ok(
            native::python_path(&self.config.control_paths()?.root().codepoints())?
                .join("operations")
                .join(REQUEST_FILE),
        )
    }
    pub fn publish_requests(
        &self,
        document: &GpuRequestDocument,
        expected: Option<&GpuFileStamp>,
    ) -> Result<()> {
        replace(&self.requests_path()?, &encode_requests(document), expected)
    }
    pub fn publish_configuration(
        &self,
        candidate: &GpuTransitionIntent,
        expected: &GpuFileStamp,
    ) -> Result<()> {
        need(
            reverie_contracts::worker_config::equivalent(
                self.config.configuration(),
                candidate.before(),
            ),
            "GPU_CONFIG_CHANGED",
        )?;
        replace(
            self.source()?,
            &candidate.configuration_bytes(),
            Some(expected),
        )
    }
    pub fn publish_binding(
        &self,
        candidate: &GpuTransitionIntent,
        expected: &GpuFileStamp,
    ) -> Result<()> {
        replace(
            &self.binding_path()?,
            &candidate.binding_bytes(),
            Some(expected),
        )
    }
}
/// No failure path unlinks a named candidate. Parent FD, writer and temporary
/// evidence are checked/retained; unknown rename/fsync is not rolled back.
fn replace(path: &Path, bytes: &[u8], expected: Option<&GpuFileStamp>) -> Result<()> {
    let parent = path
        .parent()
        .ok_or(GpuHostError::Refused("GPU_PARENT_CUSTODY"))?;
    let leaf = path
        .file_name()
        .ok_or(GpuHostError::Refused("GPU_PARENT_CUSTODY"))?;
    let directory = open_parent(parent)?;
    let mut attempted = false;
    let result = (|| {
        let mut temporary = prepare_temporary(&directory, leaf, bytes)?;
        let result = (|| {
            #[cfg(test)]
            tests::hit(tests::Point::BeforeCas, parent, &temporary.name)?;
            // `_write_exclusive` includes this parent fsync before target CAS.
            directory.sync_all()?;
            let named = match GpuFileStamp::named(&directory, leaf) {
                Ok(value) => Some(value),
                Err(GpuHostError::Io(error)) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(error),
            };
            need(named.as_ref() == expected, "GPU_FILE_CAS_CHANGED")?;
            temporary.assert_current(&directory)?;
            need(
                parent_identity(&directory.metadata()?)
                    == parent_identity(&fs::symlink_metadata(parent)?),
                "GPU_PARENT_CUSTODY_CHANGED",
            )?;
            attempted = true;
            native::replace_policy(&directory, &temporary.name, leaf)?;
            #[cfg(test)]
            tests::hit(tests::Point::Renamed, parent, &temporary.name)?;
            directory.sync_all()?;
            Ok(())
        })();
        finalized(result, temporary.close())
    })();
    let result = finalized(result, native::close(directory).map_err(Into::into));
    if attempted {
        result.map_err(|error| GpuHostError::PublicationUnknown(Box::new(error)))
    } else {
        result
    }
}
struct Prepared {
    name: OsString,
    stamp: GpuFileStamp,
    anchor: Option<File>,
}
impl Prepared {
    fn assert_current(&self, directory: &File) -> Result<()> {
        need(
            GpuFileStamp::of(
                &self
                    .anchor
                    .as_ref()
                    .expect("live prepared file")
                    .metadata()?,
            ) == self.stamp
                && GpuFileStamp::named(directory, &self.name)? == self.stamp,
            "GPU_PREPARED_FILE_CHANGED",
        )
    }
    fn close(&mut self) -> Result<()> {
        self.anchor
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into))
    }
}
fn prepare_temporary(directory: &File, leaf: &OsStr, bytes: &[u8]) -> Result<Prepared> {
    let suffix =
        reverie_store::operations::allocate_gpu_temporary_name().map_err(GpuHostError::Journal)?;
    let mut name = leaf.to_os_string();
    name.push(suffix);
    let mut file = native::create_policy_temporary(directory, &name)?;
    let mut anchor = None;
    let body = (|| {
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        let stamp = GpuFileStamp::of(&file.metadata()?);
        need(
            stamp.private(native::policy_effective_uid()),
            "GPU_PREPARED_FILE_CHANGED",
        )?;
        anchor = Some(native::open_at(directory.as_raw_fd(), &name, libc::O_PATH)?);
        need(
            GpuFileStamp::of(&anchor.as_ref().expect("assigned anchor").metadata()?) == stamp,
            "GPU_PREPARED_FILE_CHANGED",
        )?;
        Ok(stamp)
    })();
    #[cfg(test)]
    let body = finalized(
        body,
        tests::hit(tests::Point::Prepared, Path::new(""), &name),
    );
    let closed = native::close(file).map_err(Into::into);
    #[cfg(test)]
    let closed = finalized(
        closed,
        tests::hit(tests::Point::WriterClosed, Path::new(""), &name),
    );
    match finalized(body, closed) {
        Ok(stamp) => Ok(Prepared {
            name,
            stamp,
            anchor,
        }),
        Err(error) => finalized(
            Err(error),
            anchor
                .take()
                .map_or(Ok(()), |file| native::close(file).map_err(Into::into)),
        ),
    }
}
fn parent_identity(info: &fs::Metadata) -> (u64, u64, u32, u32, u32) {
    use std::os::unix::fs::MetadataExt;
    (info.dev(), info.ino(), info.mode(), info.uid(), info.gid())
}
fn open_parent(path: &Path) -> Result<File> {
    storage_identity::canonical(path)?;
    let components = path.components().skip(1).collect::<Vec<_>>();
    let mut directory = native::open_at(
        libc::AT_FDCWD,
        OsStr::new("/"),
        (if components.is_empty() {
            libc::O_RDONLY
        } else {
            libc::O_PATH
        }) | libc::O_DIRECTORY,
    )?;
    for (index, part) in components.iter().enumerate() {
        let flags = if index + 1 == components.len() {
            libc::O_RDONLY | libc::O_DIRECTORY
        } else {
            libc::O_PATH | libc::O_DIRECTORY
        };
        let next =
            native::open_at(directory.as_raw_fd(), part.as_os_str(), flags).map_err(Into::into);
        let closed = native::close(directory).map_err(Into::into);
        directory = match (next, closed) {
            (Ok(file), Ok(())) => file,
            (Err(error), closed) => return finalized(Err(error), closed),
            (Ok(file), Err(error)) => {
                return finalized(Err(error), native::close(file).map_err(Into::into));
            }
        };
    }
    Ok(directory)
}
