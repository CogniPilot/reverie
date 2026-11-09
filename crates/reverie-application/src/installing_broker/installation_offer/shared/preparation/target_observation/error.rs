use super::*;
use reverie_host::worker_pool::PoolTargetObservationError;

/// Original typed causes; display/debug expose only fixed diagnostic codes.
pub enum OfferTargetObservationError {
    Offer(Box<BrokerInstallationOfferCause>),
    Target(PoolTargetObservationError),
    Refused(&'static str),
}
impl OfferTargetObservationError {
    pub(super) fn offer(cause: BrokerInstallationOfferCause) -> Self {
        Self::Offer(Box::new(cause))
    }
    pub fn code(&self) -> &'static str {
        match self {
            Self::Offer(cause) => cause.code(),
            Self::Target(cause) => cause.code(),
            Self::Refused(code) => code,
        }
    }
}
impl std::fmt::Debug for OfferTargetObservationError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("OfferTargetObservationError")
            .field(&self.code())
            .finish()
    }
}
impl std::fmt::Display for OfferTargetObservationError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for OfferTargetObservationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Offer(cause) => Some(cause.as_ref()),
            Self::Target(cause) => Some(cause),
            Self::Refused(_) => None,
        }
    }
}
impl std::fmt::Debug for OfferTargetObservationFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("OfferTargetObservationFailure")
            .field("primary", &self.cause)
            .field("cleanup", &self.cleanup_error())
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for OfferTargetObservationFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for OfferTargetObservationFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.cause.as_ref())
    }
}
