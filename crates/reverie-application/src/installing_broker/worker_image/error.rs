use super::*;
#[derive(Debug)]
pub enum WorkerImageQualificationError {
    Gate(GateError),
    Data(reverie_contracts::resource_actor::ResourceActorDataError),
    Native(reverie_host::website_facts::WebsiteFactsError),
    Observer(crate::reservation_observer::ObserverError),
    Rootless(reverie_host::rootless::RootlessHostError),
    Refused(&'static str),
    Finalization(Box<Self>, Box<Self>),
}
impl WorkerImageQualificationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Gate(e) => e.code(),
            Self::Data(e) => e.code(),
            Self::Native(e) => e.code(),
            Self::Observer(e) => e.code(),
            Self::Rootless(e) => e.code(),
            Self::Refused(code) => code,
            Self::Finalization(..) => "WORKER_IMAGE_QUALIFICATION_FINALIZATION",
        }
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
        let Some(owner) = &self.owner else {
            return Ok(());
        };
        owner.close(end)?;
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
