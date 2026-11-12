use std::{fmt, io, process::Child};
#[derive(Debug)]
pub(super) enum Error {
    Refused(&'static str),
    Io(io::Error),
    Data(reverie_contracts::resource_actor::ResourceActorDataError),
    Close(Box<Self>),
    Finalization(Box<Self>, Box<Self>),
    Wait {
        cause: io::Error,
        _child: Box<Child>,
    },
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(code) => f.write_str(code),
            Self::Io(error) => error.fmt(f),
            Self::Data(error) => error.fmt(f),
            Self::Close(error) => write!(f, "POOL_IMAGE_CLOSE_UNCONFIRMED: {error}"),
            Self::Finalization(first, second) => write!(f, "{first}; cleanup: {second}"),
            Self::Wait { cause, .. } => write!(f, "POOL_IMAGE_TAR_WAIT_UNCONFIRMED: {cause}"),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) | Self::Wait { cause: error, .. } => Some(error),
            Self::Data(error) => Some(error),
            Self::Close(error) | Self::Finalization(error, _) => Some(error.as_ref()),
            Self::Refused(_) => None,
        }
    }
}
impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<reverie_contracts::resource_actor::ResourceActorDataError> for Error {
    fn from(error: reverie_contracts::resource_actor::ResourceActorDataError) -> Self {
        Self::Data(error)
    }
}
pub(super) type Result<T> = std::result::Result<T, Error>;
pub(super) fn need(value: bool, code: &'static str) -> Result<()> {
    value.then_some(()).ok_or(Error::Refused(code))
}
pub(super) fn finalized<T>(body: Result<T>, close: Result<()>) -> Result<T> {
    match (body, close) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(Error::Close(Box::new(error))),
        (Err(first), Err(second)) => Err(Error::Finalization(
            Box::new(first),
            Box::new(Error::Close(Box::new(second))),
        )),
    }
}

pub(super) fn combined<T>(body: Result<T>, observed: Result<()>) -> Result<T> {
    match (body, observed) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error),
        (Err(first), Err(second)) => Err(Error::Finalization(Box::new(first), Box::new(second))),
    }
}
