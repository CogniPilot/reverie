use super::*;
pub enum OfflineActorSetupError<'a> {
    Refused(&'static str),
    Original(OfflineImageSwitchError<'a>),
    Gate(GateError),
    Files(Rc<reverie_host::gpu_access::ActorSetupControlError>),
    Facts(Rc<ActorSetupFactsError>),
    History(Rc<ActorSetupHistoryError>),
}
impl OfflineActorSetupError<'_> {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Original(cause) => cause.code(),
            Self::Gate(cause) => cause.code(),
            Self::Files(cause) => cause.code(),
            Self::Facts(cause) => cause.code(),
            Self::History(cause) => cause.code(),
        }
    }
}
impl std::fmt::Debug for OfflineActorSetupError<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("OfflineActorSetupError")
            .field(&self.code())
            .finish()
    }
}
impl std::fmt::Display for OfflineActorSetupError<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for OfflineActorSetupError<'_> {}
pub struct OfflineActorSetupFailure<'a> {
    owner: Option<Box<Owner<'a>>>,
    cause: OfflineActorSetupError<'a>,
    cleanup: Vec<OfflineActorSetupError<'a>>,
    attempted: bool,
}
impl<'a> OfflineActorSetupFailure<'a> {
    pub(super) fn new(owner: Box<Owner<'a>>, cause: OfflineActorSetupError<'a>) -> Box<Self> {
        let mut failure = Box::new(Self {
            owner: Some(owner),
            cause,
            cleanup: Vec::new(),
            attempted: false,
        });
        let _ = failure.close_components();
        failure
    }
    pub fn cause(&self) -> &OfflineActorSetupError<'a> {
        &self.cause
    }
    pub fn cleanup_errors(&self) -> &[OfflineActorSetupError<'a>] {
        &self.cleanup
    }
    pub fn close_components(&mut self) -> Result<'a, ()> {
        if !self.attempted {
            self.attempted = true;
            if let Self {
                cause: OfflineActorSetupError::Original(cause),
                cleanup,
                ..
            } = self
            {
                let mut errors = Vec::new();
                cause.close_components(&mut errors);
                cleanup.extend(errors.into_iter().map(OfflineActorSetupError::Original));
            }
            if let Some(owner) = &mut self.owner {
                owner.cleanup(&mut self.cleanup);
            }
        }
        require(self.cleanup.is_empty(), "ACTOR_SETUP_FINALIZATION_RETAINED")
    }
}
impl std::fmt::Debug for OfflineActorSetupFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("OfflineActorSetupFailure")
            .field("cause", &self.cause)
            .field("cleanup", &self.cleanup)
            .finish()
    }
}
impl std::fmt::Display for OfflineActorSetupFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for OfflineActorSetupFailure<'_> {}
impl Drop for OfflineActorSetupFailure<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
