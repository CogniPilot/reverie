use super::*;
use crate::{ObservationError, private_pending::PendingError};
use reverie_contracts::{reservation_engine::EngineDataError, storage_identity::IdentityDataError};
use std::{fmt, io};
#[derive(Debug)]
enum Cause {
    Refused(&'static str),
    Io(io::Error),
    Native(ObservationError),
    Shared(gpu_access::GpuHostError),
    Configuration(EngineDataError),
    Data(IdentityDataError),
    Transition(reverie_contracts::worker_image_switch::ImageDataError),
    Service(crate::worker_service::WorkerServiceError),
    Pending(PendingError),
    Identity(reverie_store::storage_identity::IdentityError),
    Finalized(ImageFileError, ImageFileError),
    PublicationUnknown(ImageFileError),
}
#[derive(Clone, Debug)]
pub struct ImageFileError(Arc<Cause>);
impl ImageFileError {
    pub(super) fn service(error: crate::worker_service::WorkerServiceError) -> Self {
        Self(Arc::new(Cause::Service(error)))
    }
    pub(super) fn refused(code: &'static str) -> Self {
        Self(Arc::new(Cause::Refused(code)))
    }
    pub(super) fn io(e: io::Error) -> Self {
        Self(Arc::new(Cause::Io(e)))
    }
    pub(super) fn native(e: ObservationError) -> Self {
        Self(Arc::new(Cause::Native(e)))
    }
    pub(super) fn shared(e: gpu_access::GpuHostError) -> Self {
        Self(Arc::new(Cause::Shared(e)))
    }
    pub(super) fn configuration(e: EngineDataError) -> Self {
        Self(Arc::new(Cause::Configuration(e)))
    }
    pub(super) fn data(e: IdentityDataError) -> Self {
        Self(Arc::new(Cause::Data(e)))
    }
    pub(super) fn transition(e: reverie_contracts::worker_image_switch::ImageDataError) -> Self {
        Self(Arc::new(Cause::Transition(e)))
    }
    pub(super) fn pending(e: PendingError) -> Self {
        Self(Arc::new(Cause::Pending(e)))
    }
    pub(super) fn identity(e: reverie_store::storage_identity::IdentityError) -> Self {
        Self(Arc::new(Cause::Identity(e)))
    }
    pub fn code(&self) -> &'static str {
        match self.0.as_ref() {
            Cause::Refused(code) => code,
            Cause::Io(_) => "WORKER_IMAGE_FILE_IO",
            Cause::Native(e) => e.code(),
            Cause::Shared(_) => "WORKER_IMAGE_FILE_PUBLICATION",
            Cause::Configuration(e) => e.code(),
            Cause::Data(_) => "WORKER_IMAGE_FILE_DATA",
            Cause::Transition(e) => e.code(),
            Cause::Service(e) => service_code(e),
            Cause::Pending(_) => "WORKER_IMAGE_PENDING_UNCONFIRMED",
            Cause::Identity(e) => e.code(),
            Cause::Finalized(primary, _) => primary.code(),
            Cause::PublicationUnknown(_) => "WORKER_IMAGE_PUBLICATION_UNCONFIRMED",
        }
    }
    pub fn has_unconfirmed_close(&self) -> bool {
        match self.0.as_ref() {
            Cause::Native(e) => e.has_unconfirmed_close(),
            Cause::Identity(e) => e.has_unconfirmed_close(),
            Cause::Shared(e) => shared_close(e),
            Cause::Pending(e) => pending_close(e),
            Cause::Finalized(a, b) => a.has_unconfirmed_close() || b.has_unconfirmed_close(),
            Cause::PublicationUnknown(error) => error.has_unconfirmed_close(),
            _ => false,
        }
    }
    pub fn is_uncertain(&self) -> bool {
        self.has_unconfirmed_close()
            || match self.0.as_ref() {
                Cause::PublicationUnknown(_) => true,
                Cause::Shared(error) => error.is_uncertain(),
                Cause::Pending(error) => pending_unknown(error),
                Cause::Finalized(a, b) => a.is_uncertain() || b.is_uncertain(),
                _ => false,
            }
    }
    pub(super) fn unknown(error: Self) -> Self {
        Self(Arc::new(Cause::PublicationUnknown(error)))
    }
}
fn pending_unknown(error: &PendingError) -> bool {
    match error {
        PendingError::PublicationUnknown(_) => true,
        PendingError::Finalized { primary, secondary } => {
            pending_unknown(primary) || pending_unknown(secondary)
        }
        _ => false,
    }
}
fn shared_close(e: &gpu_access::GpuHostError) -> bool {
    use gpu_access::GpuHostError as E;
    match e {
        E::Native(e) => e.has_unconfirmed_close(),
        E::Metadata(e) => e.has_unconfirmed_close(),
        E::Finalized { primary, secondary } => shared_close(primary) || shared_close(secondary),
        E::PublicationUnknown(e) => shared_close(e),
        E::ImageFence(e) => e.has_unconfirmed_close(),
        _ => false,
    }
}
fn pending_close(e: &PendingError) -> bool {
    match e {
        PendingError::Native(e) => e.has_unconfirmed_close(),
        PendingError::Finalized { primary, secondary } => {
            pending_close(primary) || pending_close(secondary)
        }
        PendingError::PublicationUnknown(e) => pending_close(e),
        _ => false,
    }
}
impl fmt::Display for ImageFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for ImageFileError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self.0.as_ref() {
            Cause::Io(e) => Some(e),
            Cause::Native(e) => Some(e),
            Cause::Shared(e) => Some(e),
            Cause::Configuration(e) => Some(e),
            Cause::Data(e) => Some(e),
            Cause::Transition(e) => Some(e),
            Cause::Service(e) => Some(e),
            Cause::Identity(e) => Some(e),
            Cause::Finalized(a, _) => Some(a),
            Cause::PublicationUnknown(error) => Some(error),
            _ => None,
        }
    }
}
fn service_code(error: &crate::worker_service::WorkerServiceError) -> &'static str {
    use crate::worker_service::WorkerServiceError as E;
    match error {
        E::Refused(code) => code,
        E::Io(_) => "WORKER_IMAGE_SERVICE_METADATA_IO",
        E::Engine(e) => e.code(),
        E::Program(code) => code,
        E::Control(_) => "NATIVE_SERVICE_QUIESCE",
        E::Configuration(error) => error.code(),
        E::Schema(_) => "NATIVE_SERVICE_CONFIGURATION_SCHEMA",
        E::Finalization(primary, _) => service_code(primary),
    }
}
pub(super) fn not_found(error: &ImageFileError) -> bool {
    matches!(error.0.as_ref(), Cause::Io(e) if e.kind() == io::ErrorKind::NotFound)
}
pub(super) fn finalized<T>(body: Result<T>, close: Result<()>) -> Result<T> {
    match (body, close) {
        (Ok(v), Ok(())) => Ok(v),
        (Err(e), Ok(())) | (Ok(_), Err(e)) => Err(e),
        (Err(a), Err(b)) => Err(ImageFileError(Arc::new(Cause::Finalized(a, b)))),
    }
}
