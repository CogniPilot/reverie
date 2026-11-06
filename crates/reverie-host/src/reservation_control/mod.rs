//! Actual private control metadata, directory and held-admission observations.
//! Installing services supply captured configuration; no request path or Source
//! constructor is exposed, and READY contents alone convey no authority.
mod draft;
mod history;
mod image;
#[cfg(test)]
mod tests;
use crate::{ObservationError, native};
pub use draft::{publish_draft, read_draft};
pub use history::{
    read_completion_receipt, read_settlement_pending, read_verification_receipt, settlement_names,
    settlement_pending_present,
};
pub use image::{CurrentImageBinding, ImageHostError, capture_current_image};
use reverie_contracts::{
    reservation_control::{ControlBinding, ControlDirectory, ControlIdentity},
    reservation_engine::{EngineDataError, ReservationConfiguration},
    storage_identity::OrderedMetadata,
};
use reverie_core::posix_path::PosixPath;
use reverie_store::storage_identity::{self, IdentityError};
use std::os::unix::fs::MetadataExt;
use std::{fmt, fs, io};
pub enum ControlHostError {
    Draft(reverie_contracts::reservation_draft::DraftDataError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
    Native(ObservationError),
    /// Preserve ledger/finalizer variants for typed inspection; no erased
    /// io::Error wrapper is needed to reach a secondary checked-close error.
    Journal(reverie_store::operations::JournalError),
    Metadata(IdentityError),
    Configuration(EngineDataError),
    Refused(&'static str),
}
impl ControlHostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Draft(e) => e.code(),
            Self::Finalization { primary, .. } => primary.code(),
            Self::Native(e) => e.code(),
            Self::Journal(e) => e.code(),
            Self::Metadata(e) => e.code(),
            Self::Configuration(e) => e.code(),
            Self::Refused(code) => code,
        }
    }
}
impl fmt::Debug for ControlHostError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_tuple("ControlHostError")
            .field(&self.code())
            .finish()
    }
}
impl fmt::Display for ControlHostError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ControlHostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Draft(error) => Some(error),
            Self::Finalization { primary, .. } => Some(primary),
            Self::Native(error) => Some(error),
            Self::Journal(error) => Some(error),
            Self::Metadata(error) => Some(error),
            Self::Configuration(error) => Some(error),
            Self::Refused(_) => None,
        }
    }
}
impl From<ObservationError> for ControlHostError {
    fn from(value: ObservationError) -> Self {
        Self::Native(value)
    }
}
impl From<IdentityError> for ControlHostError {
    fn from(value: IdentityError) -> Self {
        Self::Metadata(value)
    }
}
impl From<EngineDataError> for ControlHostError {
    fn from(value: EngineDataError) -> Self {
        Self::Configuration(value)
    }
}
impl From<io::Error> for ControlHostError {
    fn from(value: io::Error) -> Self {
        Self::Native(value.into())
    }
}
type Result<T> = std::result::Result<T, ControlHostError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(ControlHostError::Refused(code))
    }
}
pub struct AdmissionLock(native::HeldAdmission);
impl AdmissionLock {
    pub fn acquire(config: &ReservationConfiguration) -> Result<Self> {
        Ok(Self(native::open_admission(
            config.control_paths()?.root(),
        )?))
    }
    pub fn assert_current(
        &self,
        config: &ReservationConfiguration,
        binding: &ControlBinding,
    ) -> Result<()> {
        Ok(self
            .0
            .assert_current(binding.admission_lock(), config.uid()?)?)
    }
    /// Checked exactly-once close. The application must finish it before
    /// acknowledging admission; closing does not grant capacity credit.
    pub fn close(&mut self) -> Result<()> {
        Ok(self.0.close()?)
    }
}
pub fn pending_present(config: &ReservationConfiguration) -> Result<bool> {
    present(config.control_paths()?.pending())
}
/// Native path DATA selected from this captured option, without opening the
/// journal, acquiring admission or manufacturing a scope guard.
pub fn operation_directory(config: &ReservationConfiguration) -> Result<std::path::PathBuf> {
    store_directory(config, "operations")
}
pub fn profile_directory(config: &ReservationConfiguration) -> Result<std::path::PathBuf> {
    store_directory(config, "profiles")
}
/// Source lexists check selected from captured stateRoot + canonical profile
/// SID. Neither the path's absence nor the SID is execution authorization.
pub fn session_directory_present(
    config: &ReservationConfiguration,
    session: &reverie_core::ids::ProfileSessionId,
) -> Result<bool> {
    present(
        &config
            .control_paths()?
            .binding()
            .parent()
            .join(&PosixPath::from_scalar_text(session.as_str())),
    )
}
fn store_directory(config: &ReservationConfiguration, name: &str) -> Result<std::path::PathBuf> {
    Ok(native::python_path(
        &config
            .control_paths()?
            .root()
            .join(&PosixPath::from_scalar_text(name))
            .codepoints(),
    )?)
}
/// The original observe() terminal inode-only lock-name fence. This opens no
/// descriptor, creates no lock and adds no engine/kernel observation afterward.
pub fn assert_store_lock_names(
    config: &ReservationConfiguration,
    binding: &ControlBinding,
) -> Result<()> {
    let root = config.control_paths()?;
    for (name, expected) in [
        ("profiles", binding.profile_lock()),
        ("operations", binding.operation_lock()),
    ] {
        let path = root
            .root()
            .join(&PosixPath::from_scalar_text(&format!("{name}/{name}.lock")));
        let info = fs::symlink_metadata(native::python_path(&path.codepoints())?)?;
        need(
            expected.matches_native(info.dev(), info.ino()),
            "RESERVATION_PRIVATE_LOCK",
        )?;
    }
    Ok(())
}
pub fn read_marker(config: &ReservationConfiguration) -> Result<OrderedMetadata> {
    read_private_ordered(config.control_paths()?.binding(), config.uid()?)
}
pub fn host_job_finishing_present(config: &ReservationConfiguration) -> Result<bool> {
    present(&operation_leaf(config, "host-job.finish.pending.json")?)
}
pub fn read_host_job_intent(config: &ReservationConfiguration) -> Result<Option<OrderedMetadata>> {
    let path = operation_leaf(config, "host-job.intent.json")?;
    if !present(&path)? {
        return Ok(None);
    }
    Ok(Some(read_private_ordered(&path, config.uid()?)?))
}
pub fn read_host_job_receipt(
    config: &ReservationConfiguration,
    job: &reverie_core::host_scope::HostJobId,
) -> Result<reverie_contracts::storage_identity::Metadata> {
    let path = operation_leaf(config, &format!("host-job-settled-{}.json", job.as_str()))?;
    let path = native::python_path(&path.codepoints())?;
    let metadata = storage_identity::read_metadata(
        &path,
        config.uid()?,
        reverie_contracts::operations_v1::MAX_BYTES,
    )?;
    need(
        fs::symlink_metadata(path)?.mode() & 0o7777 == 0o600,
        "RESERVATION_PRIVATE_FILE",
    )?;
    Ok(metadata)
}
fn operation_leaf(config: &ReservationConfiguration, leaf: &str) -> Result<PosixPath> {
    Ok(config
        .control_paths()?
        .root()
        .join(&PosixPath::from_scalar_text("operations"))
        .join(&PosixPath::from_scalar_text(leaf)))
}
fn read_private_ordered(path: &PosixPath, uid: u32) -> Result<OrderedMetadata> {
    let path = native::python_path(&path.codepoints())?;
    let metadata = storage_identity::read_ordered_metadata(
        &path,
        uid,
        reverie_contracts::operations_v1::MAX_BYTES,
    )?;
    need(
        fs::symlink_metadata(path)?.mode() & 0o7777 == 0o600,
        "RESERVATION_PRIVATE_FILE",
    )?;
    Ok(metadata)
}
/// Fixed filesystem portion of _guard, preserving the original marker's
/// directory iteration order. Image/pending/native census fences remain in the
/// application and must surround this observation at their source phases.
pub fn guard_layout(
    config: &ReservationConfiguration,
    binding: &ControlBinding,
    admission: &AdmissionLock,
) -> Result<()> {
    let paths = config.control_paths()?;
    let owner = config.uid()?;
    directory(
        &paths.binding().parent(),
        owner,
        binding.state_directory(),
        "RESERVATION_STATE_DIRECTORY_REBOUND",
    )?;
    for &selected in binding.directory_order() {
        let path = directory_path(paths.root(), selected);
        directory(
            &path,
            owner,
            binding.directory_identity(selected),
            "RESERVATION_DIRECTORY_REBOUND",
        )?;
    }
    for (name, expected) in [
        ("profiles", binding.profile_lock()),
        ("operations", binding.operation_lock()),
    ] {
        let path = paths
            .root()
            .join(&PosixPath::from_scalar_text(&format!("{name}/{name}.lock")));
        let metadata = fs::symlink_metadata(native::python_path(&path.codepoints())?)?;
        need(
            private(&metadata, owner) && expected.matches_native(metadata.dev(), metadata.ino()),
            "RESERVATION_PRIVATE_LOCK",
        )?;
    }
    for name in ["operations", "profiles"] {
        let path = paths
            .root()
            .join(&PosixPath::from_scalar_text(&format!("{name}/{name}.json")));
        if name == "profiles" && !present(&path)? {
            continue;
        }
        need(
            private(
                &fs::symlink_metadata(native::python_path(&path.codepoints())?)?,
                owner,
            ),
            "RESERVATION_PRIVATE_FILE",
        )?;
    }
    admission.assert_current(config, binding)
}
fn directory(
    path: &PosixPath,
    owner: u32,
    expected: &ControlIdentity,
    code: &'static str,
) -> Result<()> {
    let observed = native::control_directory(path, owner)?;
    need(
        expected.matches_native(observed.device, observed.inode),
        code,
    )
}
fn directory_path(root: &PosixPath, selected: ControlDirectory) -> PosixPath {
    if selected == ControlDirectory::Root {
        root.clone()
    } else {
        root.join(&PosixPath::from_scalar_text(selected.name()))
    }
}
fn private(metadata: &fs::Metadata, owner: u32) -> bool {
    metadata.is_file()
        && metadata.mode() & 0o7777 == 0o600
        && metadata.uid() == owner
        && metadata.nlink() == 1
}
fn present(path: &PosixPath) -> Result<bool> {
    match fs::symlink_metadata(native::python_path(&path.codepoints())?) {
        Ok(_) => Ok(true),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ENOTDIR) =>
        {
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}
