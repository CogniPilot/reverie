//! Read-only original runtime publication and launch markers, never a lease.
use super::*;
use std::os::unix::fs::MetadataExt;
#[derive(Clone, Eq, PartialEq)]
struct Stamp {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
    len: u64,
    mtime: i64,
    nanos: i64,
    ctime: i64,
    cnanos: i64,
}
fn stamp(path: &Path) -> Result<Stamp> {
    let data = fs::symlink_metadata(canonical(path)?)?;
    Ok(Stamp {
        dev: data.dev(),
        ino: data.ino(),
        mode: data.mode(),
        uid: data.uid(),
        len: data.len(),
        mtime: data.mtime(),
        nanos: data.mtime_nsec(),
        ctime: data.ctime(),
        cnanos: data.ctime_nsec(),
    })
}
fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}
#[derive(Eq, PartialEq)]
pub struct ProviderRuntimeObservation {
    paths: StoragePaths,
    runtime: Stamp,
    directory: Stamp,
    exit: String,
    completed: bool,
    starting: bool,
}
impl ProviderRuntimeObservation {
    pub fn completed(&self) -> bool {
        self.completed
    }
    pub fn starting(&self) -> bool {
        self.starting
    }
    pub fn assert_current(&self, config: &StorageIdentityConfig) -> Result<()> {
        need(
            *self == config.observe_provider_runtime(&self.paths)?,
            IdentityFault::MetadataChanged,
        )
    }
}
impl StorageIdentityConfig {
    pub fn observe_provider_runtime(
        &self,
        paths: &StoragePaths,
    ) -> Result<ProviderRuntimeObservation> {
        need(
            storage_paths(self, paths.session())? == *paths,
            IdentityFault::CurrentBindingChanged,
        )?;
        let runtime = self
            .state_root
            .raw()?
            .join(paths.session().as_str())
            .join("runtime.json");
        let before = stamp(&runtime)?;
        let exit = read_metadata(&runtime, self.uid, 65536)?.provider_runtime_exit()?;
        need(before == stamp(&runtime)?, IdentityFault::MetadataChanged)?;
        let directory = paths.home().join(".reverie-launch");
        let identity = stamp(&directory)?;
        let info = fs::symlink_metadata(&directory)?;
        need(
            info.is_dir() && identity.uid == self.uid && identity.mode & 0o077 == 0,
            IdentityFault::MetadataCustody,
        )?;
        let completed = exists(&directory.join(&exit))?;
        let nonce = exit.strip_suffix(".exit").expect("validated runtime exit");
        let starting = exists(&directory.join(format!("{nonce}.json")))?
            || exists(&directory.join(format!("{exit}.tmp")))?;
        need(
            identity == stamp(&directory)?,
            IdentityFault::MetadataChanged,
        )?;
        Ok(ProviderRuntimeObservation {
            paths: paths.clone(),
            runtime: before,
            directory: identity,
            exit,
            completed,
            starting,
        })
    }
}
