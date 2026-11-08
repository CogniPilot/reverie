use super::*;
pub struct OfflineImageSwitchError<'a> {
    kind: Cause<'a>,
}
enum Cause<'a> {
    Refused(&'static str),
    Qualification(WorkerImageQualificationError),
    Gate(GateError),
    GateOwner(Box<ImageGateFailure<'a>>),
    Service(Box<StoppedServiceFailure>),
    ServiceComponent(WorkerServiceError),
    Maintenance(Box<ImageMaintenanceFailure>),
    Files(reverie_host::worker_image::ImageFileError),
    Broker(Vec<BrokerServiceError>),
    Finalized(
        Box<OfflineImageSwitchError<'a>>,
        Box<OfflineImageSwitchError<'a>>,
    ),
}
impl<'a> OfflineImageSwitchError<'a> {
    pub fn code(&self) -> &'static str {
        match &self.kind {
            Cause::Refused(code) => code,
            Cause::Qualification(e) => e.code(),
            Cause::Gate(e) => e.code(),
            Cause::GateOwner(e) => e.cause().code(),
            Cause::Service(_) | Cause::ServiceComponent(_) => "WORKER_IMAGE_SERVICE_RETAINED",
            Cause::Maintenance(e) => e.cause().code(),
            Cause::Files(e) => e.code(),
            Cause::Broker(_) => "WORKER_IMAGE_BROKER_CLOSE_UNCONFIRMED",
            Cause::Finalized(..) => "WORKER_IMAGE_FINALIZATION_RETAINED",
        }
    }
    pub(super) fn refused(v: &'static str) -> Self {
        Self {
            kind: Cause::Refused(v),
        }
    }
    pub(super) fn qualification(v: WorkerImageQualificationError) -> Self {
        Self {
            kind: Cause::Qualification(v),
        }
    }
    pub(super) fn gate(v: GateError) -> Self {
        Self {
            kind: Cause::Gate(v),
        }
    }
    pub(super) fn gate_owner(v: Box<ImageGateFailure<'a>>) -> Self {
        Self {
            kind: Cause::GateOwner(v),
        }
    }
    pub(super) fn service(v: Box<StoppedServiceFailure>) -> Self {
        Self {
            kind: Cause::Service(v),
        }
    }
    pub(super) fn service_component(v: WorkerServiceError) -> Self {
        Self {
            kind: Cause::ServiceComponent(v),
        }
    }
    pub(super) fn maintenance(v: Box<ImageMaintenanceFailure>) -> Self {
        Self {
            kind: Cause::Maintenance(v),
        }
    }
    pub(super) fn files(v: reverie_host::worker_image::ImageFileError) -> Self {
        Self {
            kind: Cause::Files(v),
        }
    }
    pub(super) fn broker(v: Vec<BrokerServiceError>) -> Self {
        Self {
            kind: Cause::Broker(v),
        }
    }
    pub(super) fn finalized(a: Self, b: Self) -> Self {
        Self {
            kind: Cause::Finalized(Box::new(a), Box::new(b)),
        }
    }
    fn close_components(&mut self, errors: &mut Vec<Self>) {
        match &mut self.kind {
            Cause::Finalized(a, b) => {
                a.close_components(errors);
                b.close_components(errors);
            }
            Cause::GateOwner(owner) => {
                if let Err(error) = owner.close_components() {
                    errors.push(Self::gate(error));
                }
                if crate::installing_broker::resource_actor::gate_close_unknown(owner.cause()) {
                    errors.push(Self::refused("WORKER_IMAGE_NATIVE_CLOSE_UNCONFIRMED"));
                }
            }
            Cause::Service(owner) => {
                if let Err(error) = owner.close_components() {
                    errors.push(Self::service_component(error));
                }
            }
            Cause::Maintenance(owner) => {
                if let Err(error) = owner.close_components() {
                    errors.push(Self::files(error));
                }
            }
            Cause::Broker(_) => errors.push(Self::refused("WORKER_IMAGE_BROKER_CLOSE_UNCONFIRMED")),
            Cause::Gate(error)
                if crate::installing_broker::resource_actor::gate_close_unknown(error) =>
            {
                errors.push(Self::refused("WORKER_IMAGE_NATIVE_CLOSE_UNCONFIRMED"))
            }
            Cause::Qualification(error) if error.has_unconfirmed_close() => {
                errors.push(Self::refused("WORKER_IMAGE_NATIVE_CLOSE_UNCONFIRMED"))
            }
            Cause::Files(error) if error.has_unconfirmed_close() => {
                errors.push(Self::files(error.clone()))
            }
            _ => {}
        }
    }
}
impl std::fmt::Debug for OfflineImageSwitchError<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("OfflineImageSwitchError")
            .field(&self.code())
            .finish()
    }
}
impl std::fmt::Display for OfflineImageSwitchError<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.kind {
            Cause::Service(e) => e.fmt(f),
            Cause::ServiceComponent(e) => e.fmt(f),
            _ => f.write_str(self.code()),
        }
    }
}
impl std::error::Error for OfflineImageSwitchError<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match &self.kind {
            Cause::Qualification(e) => Some(e),
            Cause::Gate(e) => Some(e),
            Cause::GateOwner(e) => Some(e.cause()),
            Cause::Service(e) => Some(e.as_ref()),
            Cause::ServiceComponent(e) => Some(e),
            Cause::Maintenance(e) => Some(e.as_ref()),
            Cause::Files(e) => Some(e),
            Cause::Broker(errors) => errors.first().map(|e| e as _),
            Cause::Refused(_) => None,
            Cause::Finalized(a, b) => std::error::Error::source(a.as_ref())
                .or_else(|| std::error::Error::source(b.as_ref())),
        }
    }
}
pub struct OfflineImageSwitchFailure<'a> {
    pub(super) owner: Option<Box<Owner<'a>>>,
    pub(super) cause: OfflineImageSwitchError<'a>,
    pub(super) cleanup_attempted: bool,
    pub(super) cleanup: Vec<OfflineImageSwitchError<'a>>,
}
impl<'a> OfflineImageSwitchFailure<'a> {
    pub fn cause(&self) -> &OfflineImageSwitchError<'a> {
        &self.cause
    }
    pub fn cleanup_errors(&self) -> &[OfflineImageSwitchError<'a>] {
        &self.cleanup
    }
    /// One all-outcome component-close pass only. This never releases pending,
    /// retries publication, rolls back a config or starts any service/worker.
    pub fn close_components(&mut self) -> std::result::Result<(), &OfflineImageSwitchError<'a>> {
        if !self.cleanup_attempted {
            self.cleanup_attempted = true;
            self.cause.close_components(&mut self.cleanup);
            if let Some(owner) = &mut self.owner {
                owner.cleanup(&mut self.cleanup);
            }
        }
        self.cleanup.first().map_or(Ok(()), Err)
    }
}
impl std::fmt::Debug for OfflineImageSwitchFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("OfflineImageSwitchFailure")
            .field(&self.cause)
            .finish()
    }
}
impl std::fmt::Display for OfflineImageSwitchFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for OfflineImageSwitchFailure<'_> {}
impl Drop for OfflineImageSwitchFailure<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
