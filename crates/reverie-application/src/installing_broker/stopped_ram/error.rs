use super::*;
pub(super) type Result<T> = std::result::Result<T, Cause>;
#[derive(Debug)]
pub(super) enum Cause {
    Gate(Box<GateError>),
    Storage(Box<StorageWorkflowError>),
    Native(Arc<StoppedRamError>),
    Refused(&'static str),
    Finalization(Box<Self>, Box<Self>),
}
impl From<GateError> for Cause {
    fn from(error: GateError) -> Self {
        Self::Gate(Box::new(error))
    }
}
impl From<StorageWorkflowError> for Cause {
    fn from(error: StorageWorkflowError) -> Self {
        Self::Storage(Box::new(error))
    }
}
impl Cause {
    fn code(&self) -> &'static str {
        match self {
            Self::Gate(e) => e.code(),
            Self::Storage(e) => e.code(),
            Self::Native(e) => e.code(),
            Self::Refused(code) => code,
            Self::Finalization(..) => "RAM_STOPPED_PREPARATION_FINALIZATION",
        }
    }
}
pub struct StoppedRamPreparationFailure<'a> {
    cause: Cause,
    owner: Option<Box<Frame<'a>>>,
}
impl StoppedRamPreparationFailure<'_> {
    pub fn code(&self) -> &'static str {
        self.cause.code()
    }
}
impl std::fmt::Debug for StoppedRamPreparationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let phase = self.owner.as_ref().map(|frame| {
            if frame.source.is_some() {
                "StoppedSource"
            } else if frame.context.is_some() {
                "OriginalClaimAndContext"
            } else if frame.claim.is_some() {
                "OriginalClaim"
            } else {
                "NoResourceTransferred"
            }
        });
        out.debug_struct("StoppedRamPreparationFailure")
            .field("cause", &self.cause)
            .field("retained_phase", &phase)
            .finish()
    }
}
impl std::fmt::Display for StoppedRamPreparationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.cause, out)
    }
}
impl std::error::Error for StoppedRamPreparationFailure<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
impl std::fmt::Display for Cause {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Native(error) => std::fmt::Display::fmt(error, out),
            Self::Finalization(primary, secondary) => {
                write!(out, "{}: {primary}; cleanup: {secondary}", self.code())
            }
            _ => out.write_str(self.code()),
        }
    }
}
impl std::error::Error for Cause {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Gate(error) => Some(error.as_ref()),
            Self::Storage(error) => Some(error.as_ref()),
            Self::Native(error) => Some(error.as_ref()),
            Self::Finalization(primary, _) => Some(primary.as_ref()),
            Self::Refused(_) => None,
        }
    }
}
pub(super) fn unowned<'a>(cause: impl Into<Cause>) -> Box<StoppedRamPreparationFailure<'a>> {
    Box::new(StoppedRamPreparationFailure {
        cause: cause.into(),
        owner: None,
    })
}
pub(super) fn owned(frame: Frame<'_>, cause: Cause) -> Box<StoppedRamPreparationFailure<'_>> {
    Box::new(StoppedRamPreparationFailure {
        cause,
        owner: Some(Box::new(frame)),
    })
}
pub(super) fn finalized<T>(body: Result<T>, closed: Result<()>) -> Result<T> {
    match (body, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(e), Ok(())) | (Ok(_), Err(e)) => Err(e),
        (Err(a), Err(b)) => Err(Cause::Finalization(Box::new(a), Box::new(b))),
    }
}
