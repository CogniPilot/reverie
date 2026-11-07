//! Observed console copies and private restore rehearsals. Paths and successful
//! copies never establish stopped-container state, writer exclusion, all-namespace metadata completeness or data-restore authority.
//! The installing application must retain its real stop/update owners and check
//! the same immutable container before and after each public operation.
mod ancestors;
mod attributes;
mod directory;
mod manifest;
mod mounts;
mod observed;
mod process;
#[cfg(test)]
mod tests;

use directory::Directory;
use manifest::Manifest;
use std::{
    fmt,
    fs::File,
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

pub const SCOPE_NOTE: &str = "verified console bytes, types, modes, UID/GID, mtime, ACLs and caller-visible xattrs from observed stopped console; independently writable accounts may exist; not whole-company quiescence; trusted/security namespace completeness and unreadable attributes not proven; full data-restore GO remains open";
pub type Result<T> = std::result::Result<T, SnapshotError>;

/// No archive names or contents are included in diagnostics. An uncertain tool
/// owner is retained in process-lifetime quarantine, never treated as reaped.
#[derive(Debug)]
pub struct SnapshotError {
    code: &'static str,
    cause: Option<Box<dyn std::error::Error + Send + Sync>>,
    secondary: Vec<SnapshotError>,
}
impl SnapshotError {
    fn caused(code: &'static str, cause: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self {
            code,
            cause: Some(Box::new(cause)),
            secondary: Vec::new(),
        }
    }
    fn refused(code: &'static str) -> Self {
        Self {
            code,
            cause: None,
            secondary: Vec::new(),
        }
    }
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn secondary(&self) -> &[SnapshotError] {
        &self.secondary
    }
}
impl fmt::Display for SnapshotError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code)
    }
}
impl std::error::Error for SnapshotError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_ref().map(|error| error.as_ref() as _)
    }
}
impl From<io::Error> for SnapshotError {
    fn from(error: io::Error) -> Self {
        Self {
            code: "SNAPSHOT_IO",
            cause: Some(Box::new(error)),
            secondary: Vec::new(),
        }
    }
}
impl From<crate::ObservationError> for SnapshotError {
    fn from(error: crate::ObservationError) -> Self {
        Self {
            code: "SNAPSHOT_FINALIZER",
            cause: Some(Box::new(error)),
            secondary: Vec::new(),
        }
    }
}
fn require(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(SnapshotError::refused(code))
    }
}
fn combine<T>(primary: Result<T>, cleanup: Result<()>) -> Result<T> {
    match (primary, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(mut primary), Err(secondary)) => {
            primary.secondary.push(secondary);
            Err(primary)
        }
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
    }
}
fn retain_file<T>(file: File, initialize: impl FnOnce(&File) -> Result<T>) -> Result<(File, T)> {
    match initialize(&file) {
        Ok(value) => Ok((file, value)),
        Err(error) => combine(Err(error), crate::native::close(file).map_err(Into::into)),
    }
}
fn deadline(end: Instant) -> Result<()> {
    require(Instant::now() < end, "SNAPSHOT_DEADLINE")
}

/// Installer-selected immutable executables. No PATH, environment, shell,
/// arbitrary argv or request-selected program is consulted.
#[derive(Clone)]
pub struct SnapshotTools(Arc<process::Tools>);
impl SnapshotTools {
    pub fn capture_installed(tar: &Path, getfattr: &Path, getfacl: &Path) -> Result<Self> {
        Ok(Self(Arc::new(process::Tools::new(tar, getfattr, getfacl)?)))
    }
    /// `source` is the observed host bind root, not the console child and not a
    /// stopped-state assertion. `destination` must be a new private directory.
    pub fn capture_console(
        &self,
        source: &Path,
        destination: &Path,
        end: Instant,
    ) -> Result<ConsoleSnapshot> {
        deadline(end)?;
        let mut partial = PartialCapture {
            source: SnapshotSource::observe(source)?,
            destination: None,
            archive: None,
        };
        let details = self.populate(&mut partial, destination, end);
        let (before, digest, mounts) = match details {
            Ok(details) => details,
            Err(error) => return combine(Err(error), partial.close()),
        };
        let mut snapshot = ConsoleSnapshot {
            tools: self.clone(),
            source: partial.source,
            destination: partial.destination.take().expect("captured directory"),
            archive: partial.archive.take().expect("captured archive"),
            digest,
            manifest: before,
            mounts,
            rehearsed: false,
        };
        match snapshot.verify_source(end) {
            Ok(()) => Ok(snapshot),
            Err(error) => combine(Err(error), snapshot.close()),
        }
    }
    fn populate(
        &self,
        partial: &mut PartialCapture,
        destination: &Path,
        end: Instant,
    ) -> Result<(
        Manifest,
        String,
        reverie_contracts::kernel_mounts::MountTable,
    )> {
        let source = &partial.source;
        let parent = std::fs::canonicalize(
            destination
                .parent()
                .ok_or_else(|| SnapshotError::refused("SNAPSHOT_DESTINATION"))?,
        )?;
        let selected = parent.join(
            destination
                .file_name()
                .ok_or_else(|| SnapshotError::refused("SNAPSHOT_DESTINATION"))?,
        );
        require(
            !selected.starts_with(source.root.path()) && !source.root.path().starts_with(&selected),
            "SNAPSHOT_OVERLAP",
        )?;
        let mounts = mounts::capture(end)?;
        mounts::disjoint(source.root.path(), &parent, &mounts)?;
        partial.destination = Some(Arc::new(Directory::create(destination)?));
        let destination = partial.destination.as_ref().expect("captured directory");
        require(
            !destination.path().starts_with(source.root.path())
                && !source.root.path().starts_with(destination.path()),
            "SNAPSHOT_OVERLAP",
        )?;
        let before = Manifest::capture(&source.root, destination, &self.0, end)?;
        partial.archive = Some(destination.create_file("console.tar")?);
        let archive = partial.archive.as_ref().expect("captured archive");
        self.0.create(
            &source.root,
            destination,
            archive,
            end,
            before.archive_limit()?,
        )?;
        archive.sync_all()?;
        destination.sync()?;
        let digest = manifest::file_digest(archive, end)?;
        Ok((before, digest, mounts))
    }
}
struct PartialCapture {
    source: SnapshotSource,
    destination: Option<Arc<Directory>>,
    archive: Option<File>,
}
impl PartialCapture {
    fn close(self) -> Result<()> {
        let archive = self.archive.map_or(Ok(()), |file| {
            crate::native::close(file).map_err(Into::into)
        });
        let source = close_directory(self.source.root);
        let destination = self.destination.map_or(Ok(()), close_directory);
        combine(combine(archive, source), destination)
    }
}

/// Retained directory observation for the application's real frozen bind
/// inventory. This supplies neither authorization nor exclusive writer custody.
pub struct ObservedDirectory(Directory);
impl ObservedDirectory {
    pub fn capture(path: &Path) -> Result<Self> {
        Ok(Self(Directory::open(path)?))
    }
    pub fn verify(&self) -> Result<()> {
        self.0.check()
    }
    pub fn path(&self) -> &Path {
        self.0.path()
    }
    pub fn identity(&self) -> (u64, u64) {
        self.0.identity()
    }
    pub fn close(self) -> Result<()> {
        self.0.close()
    }
}
/// Directory or regular-file bind DATA retained with its real original entry
/// and ancestor descriptors. Other file kinds are refused without opening them
/// for I/O. No successful observation grants permission to mutate/start/restore.
pub struct ObservedPath(observed::Observed);
impl ObservedPath {
    pub fn capture(path: &Path) -> Result<Self> {
        Ok(Self(observed::Observed::capture(path)?))
    }
    pub fn verify(&self) -> Result<()> {
        self.0.verify()
    }
    pub fn path(&self) -> &Path {
        self.0.path()
    }
    pub fn identity(&self) -> (u64, u64) {
        self.0.identity()
    }
    pub fn close(self) -> Result<()> {
        self.0.close()
    }
}

/// Observed scope DATA with real pinned directories. It does not certify the
/// origin of the input path, a stopped container, or absence of other writers.
pub struct SnapshotSource {
    root: Arc<Directory>,
}
impl SnapshotSource {
    pub fn observe(source: &Path) -> Result<Self> {
        let root = Directory::open(source)?;
        match root.child_directory("console").and_then(Directory::close) {
            Ok(()) => Ok(Self {
                root: Arc::new(root),
            }),
            Err(error) => combine(Err(error), root.close()),
        }
    }
}

/// Owns the exact archive and captured source. Dropping this object does not
/// delete either the archive or any rehearsal/partial artifacts.
pub struct ConsoleSnapshot {
    tools: SnapshotTools,
    source: SnapshotSource,
    destination: Arc<Directory>,
    archive: File,
    digest: String,
    manifest: Manifest,
    mounts: reverie_contracts::kernel_mounts::MountTable,
    rehearsed: bool,
}
impl ConsoleSnapshot {
    pub fn archive_path(&self) -> PathBuf {
        self.destination.path().join("console.tar")
    }
    pub fn archive_sha256(&self) -> &str {
        &self.digest
    }
    pub fn entry_count(&self) -> usize {
        self.manifest.entry_count()
    }
    pub fn regular_bytes(&self) -> u64 {
        self.manifest.regular_bytes()
    }
    pub fn manifest_sha256(&self) -> String {
        self.manifest.digest()
    }
    pub fn scope_note(&self) -> &'static str {
        SCOPE_NOTE
    }
    pub fn restore_rehearsed(&self) -> bool {
        self.rehearsed
    }
    /// Explicit close consumes every main held descriptor. Uncertain native
    /// process owners keep their own real descriptor copies in quarantine.
    pub fn close(self) -> Result<()> {
        let archive = crate::native::close(self.archive).map_err(SnapshotError::from);
        let source = close_directory(self.source.root);
        let destination = close_directory(self.destination);
        combine(combine(archive, source), destination)
    }
    pub fn verify_source(&mut self, end: Instant) -> Result<()> {
        self.rehearsed = false;
        self.check_archive(end)?;
        let current = Manifest::capture(&self.source.root, &self.destination, &self.tools.0, end)?;
        require(
            self.manifest.same_source(&current),
            "SNAPSHOT_SOURCE_CHANGED",
        )?;
        self.tools
            .0
            .compare(&self.source.root, &self.destination, &self.archive, end)?;
        let after = Manifest::capture(&self.source.root, &self.destination, &self.tools.0, end)?;
        require(self.manifest.same_source(&after), "SNAPSHOT_SOURCE_CHANGED")?;
        self.check_archive(end)
    }
    /// Extracts into a NEW empty private child. Numeric ownership restoration
    /// failure is a refusal, including when the invoking service lacks privilege.
    pub fn rehearse(&mut self, end: Instant) -> Result<()> {
        self.verify_source(end)?;
        let rehearsal = Arc::new(self.destination.create_child("rehearsal")?);
        let result = (|| {
            self.tools
                .0
                .extract(&rehearsal, &self.destination, &self.archive, end)?;
            self.tools
                .0
                .compare(&rehearsal, &self.destination, &self.archive, end)?;
            let restored = Manifest::capture(&rehearsal, &self.destination, &self.tools.0, end)?;
            require(
                self.manifest.same_restored(&restored),
                "SNAPSHOT_RESTORE_MISMATCH",
            )?;
            self.verify_source(end)?;
            rehearsal.sync()?;
            self.destination.sync()?;
            Ok(())
        })();
        combine(result, close_directory(rehearsal))?;
        self.rehearsed = true;
        Ok(())
    }
    fn check_archive(&self, end: Instant) -> Result<()> {
        require(
            mounts::capture(end)? == self.mounts,
            "SNAPSHOT_MOUNTS_CHANGED",
        )?;
        self.source.root.check()?;
        self.destination.check()?;
        self.destination.check_file("console.tar", &self.archive)?;
        require(
            manifest::file_digest(&self.archive, end)? == self.digest,
            "SNAPSHOT_ARCHIVE_CHANGED",
        )
    }
}
fn close_directory(directory: Arc<Directory>) -> Result<()> {
    match Arc::try_unwrap(directory) {
        Ok(directory) => directory.close(),
        Err(directory) => {
            let _ = Box::leak(Box::new(directory));
            Err(SnapshotError::refused("SNAPSHOT_DIRECTORY_RETAINED"))
        }
    }
}
