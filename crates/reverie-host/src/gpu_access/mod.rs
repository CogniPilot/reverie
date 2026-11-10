//! Fixed owner-GPU filesystem and hardware purposes. Observed data and file
//! ownership do not authorize a GPU grant, a laptop start or a native effect.
mod active;
mod consumers;
mod current;
mod files;
pub(crate) use files::WorkerProtectedStores;
#[cfg(test)]
pub(crate) use files::image_path_swap_before_cas_fixture_fault;
#[cfg(test)]
pub(crate) use files::image_pending_swap_before_cas_fixture_fault;
pub(crate) use files::open_parent as open_control_parent;
#[cfg(test)]
pub(crate) use files::{clear_image_fixture_faults, image_after_rename_fixture_fault};
pub(crate) use files::{replace_image_configuration, replace_pool_configuration};
mod hardware;
mod stamp;
pub use active::observe_active_device;
pub use consumers::installed_consumers;
pub use current::current_employee;
mod cdi;
use crate::{ObservationError, native};
pub use cdi::CdiObservation;
pub use files::{
    ActorSetupControlError, ActorSetupControlFiles, ActorSetupPending, ActorSetupTerminal,
    GpuControlFiles, GpuParentGuard, GpuPendingFile, GpuPrivateSnapshot, GpuProtectedStores,
    GpuTerminalSnapshot, PerfControlFiles, PerfPending, PerfProtectedStores, PerfTerminal,
};
pub use hardware::GpuHardware;
use reverie_contracts::{gpu_access::GpuDataError, reservation_engine::EngineDataError};
use reverie_store::storage_identity::IdentityError;
pub use stamp::GpuFileStamp;
use std::{fmt, io};
#[derive(Debug)]
pub enum GpuHostError {
    Refused(&'static str),
    Io(io::Error),
    Native(ObservationError),
    Metadata(IdentityError),
    Data(GpuDataError),
    Configuration(EngineDataError),
    Journal(reverie_store::operations::JournalError),
    Physical(reverie_core::gpu_access::GpuAccessError),
    Engine(crate::engine_metadata::EngineError),
    ImageFence(Box<crate::worker_image::ImageFileError>),
    PoolFence(Box<crate::reservation_control::ControlHostError>),
    AdmissionFence(Box<crate::reservation_control::ControlHostError>),
    Finalized {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
    PublicationUnknown(Box<Self>),
}
impl GpuHostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Io(_) => "GPU_FILE_IO",
            Self::Native(error) => error.code(),
            Self::Metadata(error) => error.code(),
            Self::Data(error) => error.code(),
            Self::Configuration(error) => error.code(),
            Self::Journal(error) => error.code(),
            Self::Physical(error) => error.code(),
            Self::Engine(error) => error.code(),
            Self::ImageFence(error) => error.code(),
            Self::PoolFence(error) | Self::AdmissionFence(error) => error.code(),
            Self::Finalized { primary, .. } => primary.code(),
            Self::PublicationUnknown(_) => "GPU_PUBLICATION_UNCONFIRMED",
        }
    }
    pub fn is_uncertain(&self) -> bool {
        match self {
            Self::PublicationUnknown(_) => true,
            Self::ImageFence(error) => error.is_uncertain(),
            Self::PoolFence(error) | Self::AdmissionFence(error) => error.has_unconfirmed_close(),
            Self::Finalized { primary, secondary } => {
                primary.is_uncertain() || secondary.is_uncertain()
            }
            _ => false,
        }
    }
    /// Descriptor-close opacity only. Rename outcome uncertainty is separate.
    pub(crate) fn has_unconfirmed_close(&self) -> bool {
        match self {
            Self::Native(error) => error.has_unconfirmed_close(),
            Self::Metadata(error) => error.has_unconfirmed_close(),
            Self::ImageFence(error) => error.has_unconfirmed_close(),
            Self::PoolFence(error) | Self::AdmissionFence(error) => error.has_unconfirmed_close(),
            Self::Finalized { primary, secondary } => {
                primary.has_unconfirmed_close() || secondary.has_unconfirmed_close()
            }
            Self::PublicationUnknown(error) => error.has_unconfirmed_close(),
            _ => false,
        }
    }
}
impl fmt::Display for GpuHostError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for GpuHostError {}
impl From<io::Error> for GpuHostError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<ObservationError> for GpuHostError {
    fn from(value: ObservationError) -> Self {
        Self::Native(value)
    }
}
impl From<IdentityError> for GpuHostError {
    fn from(value: IdentityError) -> Self {
        Self::Metadata(value)
    }
}
impl From<EngineDataError> for GpuHostError {
    fn from(value: EngineDataError) -> Self {
        Self::Configuration(value)
    }
}
impl From<GpuDataError> for GpuHostError {
    fn from(value: GpuDataError) -> Self {
        Self::Data(value)
    }
}
impl From<reverie_core::gpu_access::GpuAccessError> for GpuHostError {
    fn from(value: reverie_core::gpu_access::GpuAccessError) -> Self {
        Self::Physical(value)
    }
}
type Result<T> = std::result::Result<T, GpuHostError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(GpuHostError::Refused(code))
    }
}
fn finalized<T>(body: Result<T>, closed: Result<()>) -> Result<T> {
    match (body, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(GpuHostError::Finalized {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
