use super::*;
#[derive(Debug)]
pub enum WorkerImageQualificationError {
    Gate(GateError),
    Data(reverie_contracts::resource_actor::ResourceActorDataError),
    Native(reverie_host::website_facts::WebsiteFactsError),
    Observer(crate::reservation_observer::ObserverError),
    Rootless(reverie_host::rootless::RootlessHostError),
    ImageFiles(reverie_host::worker_image::ImageFileError),
    Refused(&'static str),
    Finalization(Box<Self>, Box<Self>),
}
impl WorkerImageQualificationError {
    pub(super) fn has_unconfirmed_close(&self) -> bool {
        match self {
            Self::Gate(e) => crate::installing_broker::resource_actor::gate_close_unknown(e),
            Self::Native(e) => facts_unknown(e),
            Self::Observer(e) => e.has_unconfirmed_close(),
            Self::ImageFiles(e) => e.has_unconfirmed_close(),
            Self::Rootless(e) => crate::worker_validation::rootless_close_unknown(e),
            Self::Finalization(a, b) => a.has_unconfirmed_close() || b.has_unconfirmed_close(),
            _ => false,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            Self::Gate(e) => e.code(),
            Self::Data(e) => e.code(),
            Self::Native(e) => e.code(),
            Self::Observer(e) => e.code(),
            Self::Rootless(e) => e.code(),
            Self::ImageFiles(e) => e.code(),
            Self::Refused(code) => code,
            Self::Finalization(..) => "WORKER_IMAGE_QUALIFICATION_FINALIZATION",
        }
    }
}
fn facts_unknown(error: &reverie_host::website_facts::WebsiteFactsError) -> bool {
    use reverie_host::website_facts::WebsiteFactsError as E;
    match error {
        E::Cleanup => true,
        E::Channel(e) => e.has_unconfirmed_close(),
        E::Finalization { primary, secondary } => {
            facts_unknown(primary) || facts_unknown(secondary)
        }
        _ => false,
    }
}
impl std::fmt::Display for WorkerImageQualificationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for WorkerImageQualificationError {}
impl From<GateError> for WorkerImageQualificationError {
    fn from(e: GateError) -> Self {
        Self::Gate(e)
    }
}
impl From<reverie_contracts::resource_actor::ResourceActorDataError>
    for WorkerImageQualificationError
{
    fn from(e: reverie_contracts::resource_actor::ResourceActorDataError) -> Self {
        Self::Data(e)
    }
}
impl From<reverie_host::website_facts::WebsiteFactsError> for WorkerImageQualificationError {
    fn from(e: reverie_host::website_facts::WebsiteFactsError) -> Self {
        Self::Native(e)
    }
}
impl From<crate::reservation_observer::ObserverError> for WorkerImageQualificationError {
    fn from(e: crate::reservation_observer::ObserverError) -> Self {
        Self::Observer(e)
    }
}
pub struct WorkerImageQualificationFailure<'a> {
    pub(super) owner: Option<Box<Qualification<'a>>>,
    pub(super) cause: WorkerImageQualificationError,
}
impl WorkerImageQualificationFailure<'_> {
    pub fn cause(&self) -> &WorkerImageQualificationError {
        &self.cause
    }
    /// Cleanup only. Unknown native input/query finalization never becomes a
    /// successful qualification or a right to publish/remove a pending file.
    pub fn close_components(&mut self, end: Instant) -> Result<()> {
        let Some(owner) = &mut self.owner else {
            return Ok(());
        };
        owner.close(end)?;
        if self.cause.has_unconfirmed_close() {
            return Err(WorkerImageQualificationError::Refused(
                "WORKER_IMAGE_NATIVE_CLOSE_UNCONFIRMED",
            ));
        }
        self.owner = None;
        Ok(())
    }
}
impl std::fmt::Debug for WorkerImageQualificationFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("WorkerImageQualificationFailure")
            .field(&self.cause)
            .finish()
    }
}
impl std::fmt::Display for WorkerImageQualificationFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for WorkerImageQualificationFailure<'_> {}
impl Drop for WorkerImageQualificationFailure<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
