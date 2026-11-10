use super::*;
pub(super) enum Cause {
    OriginalHandlers(Rc<reverie_host::worker_reports::WorkerReportError>),
    Actor(ResourceActorError),
    Offer(Box<BrokerInstallationOfferCause>),
    Target(Rc<OfferTargetObservationError>),
    Storage(storage::StorageWorkflowError),
    Refused(&'static str),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl Cause {
    pub(super) fn code(&self) -> &'static str {
        match self {
            Self::OriginalHandlers(e) => e.code(),
            Self::Actor(e) => e.code(),
            Self::Offer(e) => e.code(),
            Self::Target(e) => e.code(),
            Self::Storage(e) => e.code(),
            Self::Refused(code) => code,
            Self::Finalization { primary, .. } => primary.code(),
        }
    }
}
impl From<ResourceActorError> for Cause {
    fn from(e: ResourceActorError) -> Self {
        Self::Actor(e)
    }
}
impl From<GateError> for Cause {
    fn from(e: GateError) -> Self {
        Self::Actor(e.into())
    }
}
impl From<storage::StorageWorkflowError> for Cause {
    fn from(e: storage::StorageWorkflowError) -> Self {
        Self::Storage(e)
    }
}
impl From<ResourceActorDataError> for Cause {
    fn from(e: ResourceActorDataError) -> Self {
        Self::Actor(e.into())
    }
}
impl std::fmt::Debug for Cause {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("FleetPreviewCause")
            .field(&self.code())
            .finish()
    }
}
impl std::fmt::Display for Cause {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Finalization { primary, secondary } => {
                write!(out, "{primary}; secondary: {secondary}")
            }
            _ => out.write_str(self.code()),
        }
    }
}
impl std::error::Error for Cause {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::OriginalHandlers(e) => Some(e.as_ref()),
            Self::Actor(e) => Some(e),
            Self::Offer(e) => Some(e.as_ref()),
            Self::Target(e) => Some(e.as_ref()),
            Self::Storage(e) => Some(e),
            Self::Refused(_) => None,
            Self::Finalization { primary, .. } => Some(primary.as_ref()),
        }
    }
}
