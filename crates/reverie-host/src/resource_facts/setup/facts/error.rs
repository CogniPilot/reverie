use super::*;
pub enum ActorSetupFactsError {
    Refused(&'static str),
    Engine(EngineError),
    Website(WebsiteFactsError),
    Data(ResourceActorDataError),
    Inventory(reverie_contracts::reservation_engine::EngineDataError),
    Io(std::io::Error),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl ActorSetupFactsError {
    pub fn has_unconfirmed_close(&self) -> bool {
        match self {
            Self::Engine(cause) => cause.is_uncertain(),
            Self::Website(WebsiteFactsError::Engine(cause)) => cause.is_uncertain(),
            Self::Finalization { primary, secondary } => {
                primary.has_unconfirmed_close() || secondary.has_unconfirmed_close()
            }
            _ => false,
        }
    }
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Engine(cause) => cause.code(),
            Self::Website(cause) => cause.code(),
            Self::Data(cause) => cause.code(),
            Self::Inventory(cause) => cause.code(),
            Self::Io(_) => "ACTOR_SETUP_FIXED_INPUT_UNAVAILABLE",
            Self::Finalization { primary, .. } => primary.code(),
        }
    }
}
impl std::fmt::Debug for ActorSetupFactsError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("ActorSetupFactsError")
            .field(&self.code())
            .finish()
    }
}
impl std::fmt::Display for ActorSetupFactsError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ActorSetupFactsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(_) => None,
            Self::Engine(cause) => Some(cause),
            Self::Website(cause) => Some(cause),
            Self::Data(cause) => Some(cause),
            Self::Inventory(cause) => Some(cause),
            Self::Io(cause) => Some(cause),
            Self::Finalization { primary, .. } => Some(primary.as_ref()),
        }
    }
}
impl From<ResourceActorDataError> for ActorSetupFactsError {
    fn from(cause: ResourceActorDataError) -> Self {
        Self::Data(cause)
    }
}
impl From<WebsiteFactsError> for ActorSetupFactsError {
    fn from(cause: WebsiteFactsError) -> Self {
        Self::Website(cause)
    }
}
impl From<std::io::Error> for ActorSetupFactsError {
    fn from(cause: std::io::Error) -> Self {
        Self::Io(cause)
    }
}
pub(super) fn finalized(body: FactsResult<()>, close: FactsResult<()>) -> FactsResult<()> {
    match (body, close) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(cause), Ok(())) | (Ok(()), Err(cause)) => Err(cause),
        (Err(primary), Err(secondary)) => Err(ActorSetupFactsError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
