use super::*;
#[derive(Debug)]
pub enum ResourceActorError {
    RetainedGateClose(Arc<GateError>),
    Refused(&'static str),
    Gate(Box<GateError>),
    Data(ResourceActorDataError),
    Identity(reverie_contracts::storage_identity::IdentityDataError),
    Private(reverie_host::resource_facts::ResourceFactsError),
    Native(reverie_host::website_facts::WebsiteFactsError),
    Channel(reverie_host::worker_reports::WorkerReportError),
    Observer(crate::reservation_observer::ObserverError),
    Frame(reverie_contracts::human_protocol::HumanFrameError),
    RetainedCompanyClose(Arc<reverie_store::storage_identity::IdentityError>),
    RetainedKernelClose(Arc<reverie_host::reservation_kernel::ReservationKernelError>),
    RetainedControlClose(Arc<reverie_host::reservation_control::ControlHostError>),
    GateFinalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl ResourceActorError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::RetainedGateClose(error) => error.code(),
            Self::Refused(code) => code,
            Self::Gate(e) => e.code(),
            Self::Data(e) => e.code(),
            Self::Identity(e) => e.code(),
            Self::Private(e) => e.code(),
            Self::Native(e) => e.code(),
            Self::Channel(e) => e.code(),
            Self::Observer(e) => e.code(),
            Self::Frame(e) => e.code(),
            Self::RetainedCompanyClose(e) => e.code(),
            Self::RetainedKernelClose(e) => e.code(),
            Self::RetainedControlClose(e) => e.code(),
            Self::GateFinalization { .. } => "RESERVATION_ADMISSION_FINALIZATION",
            Self::Finalization { .. } => "RESOURCE_ACTOR_FINALIZATION",
        }
    }
    pub(super) fn has_unconfirmed_close(&self) -> bool {
        match self {
            Self::RetainedGateClose(error) => gate_close_unknown(error),
            Self::Gate(error) => gate_close_unknown(error),
            Self::Observer(error) => error.has_unconfirmed_close(),
            Self::Channel(error) => error.has_unconfirmed_close(),
            Self::RetainedCompanyClose(error) => error.has_unconfirmed_close(),
            Self::RetainedKernelClose(error) => error.has_unconfirmed_close(),
            Self::RetainedControlClose(error) => error.has_unconfirmed_close(),
            Self::Finalization { primary, secondary }
            | Self::GateFinalization { primary, secondary } => {
                primary.has_unconfirmed_close() || secondary.has_unconfirmed_close()
            }
            _ => false,
        }
    }
}
impl std::fmt::Display for ResourceActorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for ResourceActorError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::RetainedGateClose(error) => Some(&**error),
            Self::Gate(error) => Some(&**error),
            Self::Observer(error) => Some(error),
            Self::RetainedCompanyClose(error) => Some(&**error),
            Self::RetainedKernelClose(error) => Some(&**error),
            Self::RetainedControlClose(error) => Some(&**error),
            Self::Finalization { primary, .. } | Self::GateFinalization { primary, .. } => {
                Some(&**primary)
            }
            _ => None,
        }
    }
}
pub(super) fn gate_close_unknown(error: &GateError) -> bool {
    match error {
        GateError::Actor(error) => error.has_unconfirmed_close(),
        GateError::Profile(error) => error.has_unconfirmed_close(),
        GateError::Journal(error) => journal_close_unknown(error),
        GateError::Observer(error) => error.has_unconfirmed_close(),
        GateError::Identity(error) => error.has_unconfirmed_close(),
        GateError::Control(error) => error.has_unconfirmed_close(),
        GateError::Finalization { primary, secondary } => {
            gate_close_unknown(primary) || gate_close_unknown(secondary)
        }
        GateError::ClaimUncertain { cause }
        | GateError::PreparationConfigUncertain { cause }
        | GateError::PreparationIntentUncertain { cause }
        | GateError::PreparationPublicationUncertain { cause }
        | GateError::NativeStartIntentUncertain { cause }
        | GateError::NativeSourceStopUncertain { cause }
        | GateError::GpuApplyUncertain { cause } => gate_close_unknown(cause),
        _ => false,
    }
}
fn journal_close_unknown(error: &reverie_store::operations::JournalError) -> bool {
    use reverie_store::operations::JournalError;
    match error {
        JournalError::Filesystem(error) => error.has_unconfirmed_close(),
        JournalError::Finalization { primary, secondary } => {
            journal_close_unknown(primary) || journal_close_unknown(secondary)
        }
        JournalError::CommitUncertain { cause } => journal_close_unknown(cause),
        // Store deliberately retains the original typed application guard
        // without depending on Application. Recognize only that exact type.
        JournalError::ScopeGuard { cause, .. } => cause
            .downcast_ref::<GateError>()
            .is_some_and(gate_close_unknown),
        JournalError::Refused(_) => false,
    }
}
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
