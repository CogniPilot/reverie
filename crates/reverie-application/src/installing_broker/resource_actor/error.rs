use super::*;
#[derive(Debug)]
pub enum ResourceActorError {
    Refused(&'static str),
    Gate(Box<GateError>),
    Data(ResourceActorDataError),
    Identity(reverie_contracts::storage_identity::IdentityDataError),
    Private(reverie_host::resource_facts::ResourceFactsError),
    Native(reverie_host::website_facts::WebsiteFactsError),
    Channel(reverie_host::worker_reports::WorkerReportError),
    Observer(crate::reservation_observer::ObserverError),
    Frame(reverie_contracts::human_protocol::HumanFrameError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl ResourceActorError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Gate(e) => e.code(),
            Self::Data(e) => e.code(),
            Self::Identity(e) => e.code(),
            Self::Private(e) => e.code(),
            Self::Native(e) => e.code(),
            Self::Channel(e) => e.code(),
            Self::Observer(e) => e.code(),
            Self::Frame(e) => e.code(),
            Self::Finalization { .. } => "RESOURCE_ACTOR_FINALIZATION",
        }
    }
}
impl std::fmt::Display for ResourceActorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for ResourceActorError {}
impl From<GateError> for ResourceActorError {
    fn from(e: GateError) -> Self {
        Self::Gate(Box::new(e))
    }
}
impl From<ResourceActorDataError> for ResourceActorError {
    fn from(e: ResourceActorDataError) -> Self {
        Self::Data(e)
    }
}
impl From<reverie_contracts::storage_identity::IdentityDataError> for ResourceActorError {
    fn from(e: reverie_contracts::storage_identity::IdentityDataError) -> Self {
        Self::Identity(e)
    }
}
impl From<reverie_host::resource_facts::ResourceFactsError> for ResourceActorError {
    fn from(e: reverie_host::resource_facts::ResourceFactsError) -> Self {
        Self::Private(e)
    }
}
impl From<reverie_host::website_facts::WebsiteFactsError> for ResourceActorError {
    fn from(e: reverie_host::website_facts::WebsiteFactsError) -> Self {
        Self::Native(e)
    }
}
impl From<reverie_host::worker_reports::WorkerReportError> for ResourceActorError {
    fn from(e: reverie_host::worker_reports::WorkerReportError) -> Self {
        Self::Channel(e)
    }
}
impl From<crate::reservation_observer::ObserverError> for ResourceActorError {
    fn from(e: crate::reservation_observer::ObserverError) -> Self {
        Self::Observer(e)
    }
}
impl From<reverie_contracts::human_protocol::HumanFrameError> for ResourceActorError {
    fn from(e: reverie_contracts::human_protocol::HumanFrameError) -> Self {
        Self::Frame(e)
    }
}
pub(super) type Result<T> = std::result::Result<T, ResourceActorError>;
pub(super) fn finalized(primary: Result<()>, secondary: Result<()>) -> Result<()> {
    match (primary, secondary) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(e), Ok(())) | (Ok(()), Err(e)) => Err(e),
        (Err(primary), Err(secondary)) => Err(ResourceActorError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
pub(super) fn need(ok: bool, code: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(ResourceActorError::Refused(code))
    }
}
#[must_use = "retain the whole failed channel and native observers until checked finalization"]
pub struct ResourceActorFailure<'a> {
    pub(super) frame: Frame<'a>,
    pub(super) cause: ResourceActorError,
}
impl ResourceActorFailure<'_> {
    pub fn cause(&self) -> &ResourceActorError {
        &self.cause
    }
    /// Transport component only. A failing observer's uncertain close keeps
    /// the original hold counted. No resource phase/capacity ACK is returned.
    pub fn close_channel_component(&mut self, end: Instant) -> Result<WorkerLaunchClose> {
        self.frame.close(end)
    }
}
impl std::fmt::Debug for ResourceActorFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResourceActorFailure")
            .field("cause", &self.cause)
            .finish_non_exhaustive()
    }
}
