use super::*;
pub enum ActorSetupHistoryError {
    Refused(&'static str),
    Private(GoalCustodyError),
    Data(ActorSetupDataError),
    Configuration(reverie_contracts::reservation_engine::EngineDataError),
    Scan(reverie_store::operations::JournalError),
    Publication(Rc<crate::gpu_access::ActorSetupControlError>),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl ActorSetupHistoryError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Private(_) => "ACTOR_SETUP_HISTORY_PRIVATE",
            Self::Data(cause) => cause.code(),
            Self::Configuration(cause) => cause.code(),
            Self::Scan(cause) => cause.code(),
            Self::Publication(cause) => cause.code(),
            Self::Finalization { primary, .. } => primary.code(),
        }
    }
    pub fn has_unconfirmed_close(&self) -> bool {
        match self {
            Self::Private(GoalCustodyError::Cleanup) => true,
            Self::Private(GoalCustodyError::Native(cause)) => cause.has_unconfirmed_close(),
            Self::Scan(cause) => scan_unknown(cause),
            Self::Publication(cause) => cause.has_unconfirmed_close(),
            Self::Finalization { primary, secondary } => {
                primary.has_unconfirmed_close() || secondary.has_unconfirmed_close()
            }
            _ => false,
        }
    }
}
fn scan_unknown(cause: &reverie_store::operations::JournalError) -> bool {
    use reverie_store::operations::JournalError;
    match cause {
        JournalError::Filesystem(cause) => cause.has_unconfirmed_close(),
        JournalError::Finalization { primary, secondary } => {
            scan_unknown(primary) || scan_unknown(secondary)
        }
        JournalError::CommitUncertain { .. } | JournalError::ScopeGuard { .. } => true,
        JournalError::Refused(_) => false,
    }
}
impl From<GoalCustodyError> for ActorSetupHistoryError {
    fn from(cause: GoalCustodyError) -> Self {
        Self::Private(cause)
    }
}
impl From<ActorSetupDataError> for ActorSetupHistoryError {
    fn from(cause: ActorSetupDataError) -> Self {
        Self::Data(cause)
    }
}
impl std::fmt::Debug for ActorSetupHistoryError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("ActorSetupHistoryError")
            .field(&self.code())
            .finish()
    }
}
impl std::fmt::Display for ActorSetupHistoryError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ActorSetupHistoryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Private(cause) => Some(cause),
            Self::Data(cause) => Some(cause),
            Self::Configuration(cause) => Some(cause),
            Self::Scan(cause) => Some(cause),
            Self::Publication(cause) => Some(cause.as_ref()),
            Self::Finalization { primary, .. } => Some(primary.as_ref()),
            Self::Refused(_) => None,
        }
    }
}
pub(super) fn finalized(body: HistoryResult<()>, close: HistoryResult<()>) -> HistoryResult<()> {
    match (body, close) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(cause), Ok(())) | (Ok(()), Err(cause)) => Err(cause),
        (Err(primary), Err(secondary)) => Err(ActorSetupHistoryError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
