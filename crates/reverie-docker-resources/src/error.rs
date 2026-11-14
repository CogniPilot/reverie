use std::{fmt, io};

pub(crate) type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub(crate) enum Error {
    Refused(&'static str),
    Io(io::Error),
    Finalization {
        primary: Option<Box<Self>>,
        close: Vec<io::Error>,
    },
}
impl From<io::Error> for Error {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl fmt::Display for Error {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(code) => write!(out, "{code}"),
            Self::Io(error) => write!(out, "BOXED_RESOURCE_IO: {error}"),
            Self::Finalization { primary, close } => {
                if let Some(primary) = primary {
                    write!(out, "{primary}; ")?;
                }
                write!(out, "BOXED_RESOURCE_CLOSE_UNCONFIRMED: {close:?}")
            }
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(_) => None,
            Self::Io(error) => Some(error),
            Self::Finalization { primary, close } => primary
                .as_deref()
                .map(|error| error as &dyn std::error::Error)
                .or_else(|| close.first().map(|error| error as &dyn std::error::Error)),
        }
    }
}
pub(crate) fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(Error::Refused(code))
    }
}
pub(crate) fn finalized<T>(result: Result<T>, close: Vec<io::Error>) -> Result<T> {
    if close.is_empty() {
        return result;
    }
    Err(Error::Finalization {
        primary: result.err().map(Box::new),
        close,
    })
}
