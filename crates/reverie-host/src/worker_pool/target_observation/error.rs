use crate::engine_metadata::EngineError;
/// Typed original query/validation failure. No string classification of native
/// uncertainty and no conversion from this DATA error into a readiness grant.
#[derive(Clone, Debug)]
pub enum PoolTargetObservationError {
    Refused(&'static str),
    Engine(EngineError),
}
impl PoolTargetObservationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Engine(error) => error.code(),
        }
    }
}
impl std::fmt::Display for PoolTargetObservationError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for PoolTargetObservationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Engine(error) => Some(error),
            Self::Refused(_) => None,
        }
    }
}
