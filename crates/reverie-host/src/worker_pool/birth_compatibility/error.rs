use super::*;

#[derive(Clone, Copy, Debug)]
pub(super) enum Failure {
    Unmeasured,
    ImageMismatch,
    ReplyMismatch,
    Replayed,
    CloseUnknown,
    DecoderRefused,
    Unconfirmed,
}
/// Typed decoder-stage failure; it carries no birth payload or effect authority.
#[derive(Debug)]
pub struct ControllerBirthCompatibilityError {
    reason: Failure,
    cause: Option<Box<PoolError>>,
}
impl ControllerBirthCompatibilityError {
    pub fn code(&self) -> &'static str {
        match self.reason {
            Failure::Unmeasured => "WORKER_POOL_CONTROLLER_BIRTH_CAPABILITY_UNMEASURED",
            Failure::ImageMismatch => "WORKER_POOL_CONTROLLER_BIRTH_IMAGE_MISMATCH",
            Failure::ReplyMismatch => "WORKER_POOL_CONTROLLER_BIRTH_REPLY_MISMATCH",
            Failure::Replayed => "WORKER_POOL_CONTROLLER_BIRTH_CHECK_REPLAYED",
            Failure::CloseUnknown => "WORKER_POOL_CONTROLLER_BIRTH_CHECK_CLOSE_UNKNOWN",
            Failure::DecoderRefused => "WORKER_POOL_CONTROLLER_BIRTH_DECODER_REFUSED",
            Failure::Unconfirmed => "WORKER_POOL_CONTROLLER_BIRTH_CHECK_UNCONFIRMED",
        }
    }
    pub fn has_unconfirmed_close(&self) -> bool {
        matches!(self.reason, Failure::CloseUnknown)
            || self
                .cause
                .as_ref()
                .is_some_and(|e| e.has_unconfirmed_close())
    }
    pub(super) fn native(cause: crate::engine_metadata::EngineError) -> Self {
        Self {
            reason: Failure::DecoderRefused,
            cause: Some(Box::new(PoolError::Engine(cause))),
        }
    }
}
impl fmt::Display for ControllerBirthCompatibilityError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ControllerBirthCompatibilityError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause
            .as_ref()
            .map(|e| e.as_ref() as &dyn std::error::Error)
    }
}
pub(super) fn refused(reason: Failure) -> PoolError {
    PoolError::BirthCompatibility(Box::new(ControllerBirthCompatibilityError {
        reason,
        cause: None,
    }))
}
pub(super) fn wrap(error: PoolError) -> PoolError {
    if matches!(error, PoolError::BirthCompatibility(_)) {
        return error;
    }
    PoolError::BirthCompatibility(Box::new(ControllerBirthCompatibilityError {
        reason: Failure::Unconfirmed,
        cause: Some(Box::new(error)),
    }))
}
