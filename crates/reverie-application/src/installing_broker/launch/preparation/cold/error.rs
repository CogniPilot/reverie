use super::*;
#[derive(Debug)]
pub(super) enum ColdError {
    Preparation(PreparationError),
    Storage(StorageWorkflowError),
    Nix(storage::NixStorageError),
    Network(storage::NetworkStorageError),
    Office(reverie_host::office::OfficeError),
    Refused(&'static str),
    Finalized { primary: Box<Self>, secondary: Box<Self> },
}
impl std::fmt::Display for ColdError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Preparation(e) => e.fmt(out), Self::Storage(e) => e.fmt(out),
            Self::Nix(e) => e.fmt(out), Self::Network(e) => e.fmt(out), Self::Office(e) => e.fmt(out),
            Self::Refused(text) => out.write_str(text),
            Self::Finalized { primary, .. } => primary.fmt(out),
        }
    }
}
impl std::error::Error for ColdError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Preparation(e) => Some(e), Self::Storage(e) => Some(e),
            Self::Nix(e) => Some(e), Self::Network(e) => Some(e), Self::Office(e) => Some(e),
            Self::Refused(_) => None, Self::Finalized { primary, .. } => Some(primary.as_ref()),
        }
    }
}
macro_rules! from {
    ($ty:ty,$case:ident) => { impl From<$ty> for ColdError { fn from(e:$ty)->Self { Self::$case(e) } } };
}
from!(PreparationError,Preparation);
from!(StorageWorkflowError,Storage);
from!(storage::NixStorageError,Nix);
from!(storage::NetworkStorageError,Network);
from!(reverie_host::office::OfficeError,Office);
impl From<GateError> for ColdError {
    fn from(error: GateError) -> Self { Self::Preparation(error.into()) }
}
pub(super) fn finalized(primary: ColdError, secondary: ColdError) -> ColdError {
    ColdError::Finalized { primary: Box::new(primary), secondary: Box::new(secondary) }
}
