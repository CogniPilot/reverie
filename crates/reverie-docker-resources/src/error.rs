use std::{fmt, io};

pub(crate) type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub(crate) enum Error {
    Refused(&'static str),
    Io(Fault),
    Finalization {
        primary: Option<Box<Self>>,
        close: Vec<io::Error>,
    },
}
/// One failed system call, with the object it was issued against when known.
#[derive(Debug)]
pub(crate) struct Fault {
    source: io::Error,
    /// The path the call named, as this helper opened it.
    path: Option<String>,
    /// Whose object that was: the box, the anchor, the worker, a member, one
    /// of its tasks, or the writable leaf or pool.
    subject: Option<String>,
}
impl From<io::Error> for Error {
    fn from(source: io::Error) -> Self {
        Self::Io(Fault {
            source,
            path: None,
            subject: None,
        })
    }
}
impl Error {
    fn located(self, change: impl FnOnce(&mut Fault)) -> Self {
        match self {
            Self::Refused(_) => self,
            Self::Io(mut fault) => {
                change(&mut fault);
                Self::Io(fault)
            }
            Self::Finalization { primary, close } => Self::Finalization {
                primary: primary.map(|error| Box::new(error.located(change))),
                close,
            },
        }
    }
    /// Names the path of a failed system call. The innermost name is kept.
    pub(crate) fn at(self, path: impl FnOnce() -> String) -> Self {
        self.located(|fault| {
            fault.path.get_or_insert_with(path);
        })
    }
    /// Names whose object a failed system call concerned. The innermost name is kept.
    pub(crate) fn of(self, subject: impl FnOnce() -> String) -> Self {
        self.located(|fault| {
            fault.subject.get_or_insert_with(subject);
        })
    }
    /// The kernel error number of a failed system call, unless a close was
    /// lost as well: that outcome is never just the call's.
    pub(crate) fn errno(&self) -> Option<i32> {
        match self {
            Self::Io(fault) => fault.source.raw_os_error(),
            Self::Refused(_) | Self::Finalization { .. } => None,
        }
    }
}
impl fmt::Display for Fault {
    /// The bare form is what earlier helpers printed; context only follows it.
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "BOXED_RESOURCE_IO: {}", self.source)?;
        if let Some(path) = &self.path {
            write!(out, " at {path}")?;
        }
        if let Some(subject) = &self.subject {
            write!(out, " ({subject})")?;
        }
        Ok(())
    }
}
impl fmt::Display for Error {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(code) => write!(out, "{code}"),
            Self::Io(fault) => write!(out, "{fault}"),
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
            Self::Io(fault) => Some(&fault.source),
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
