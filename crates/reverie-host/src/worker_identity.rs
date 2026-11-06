//! Same-captured-domain path conversion for the native storage reader.
use crate::native;
use reverie_contracts::resource_config::ResourceIdentitySettings;
use reverie_store::storage_identity::{IdentityError, StorageIdentityConfig};

/// Convert captured Python path codepoints using the same POSIX
/// surrogateescape owner as the lease adapter. Settings are data, not grants.
pub fn storage_identity(
    settings: &ResourceIdentitySettings,
) -> Result<StorageIdentityConfig, IdentityError> {
    StorageIdentityConfig::try_new(
        native::python_path(settings.company_file().codepoints())?,
        native::python_path(settings.state_root().codepoints())?,
        native::python_path(settings.scratch_root().codepoints())?,
        settings.uid(),
    )
}
