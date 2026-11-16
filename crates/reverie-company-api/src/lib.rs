//! Opt-in fresh-company Rust authority. Never opens or migrates a deployed company.
//! Registration is metadata only; native lifecycle work remains explicitly held.
#![forbid(unsafe_code)]
mod api;
pub mod client;
mod document;
mod filesystem;
pub mod qualification;
pub mod server;
mod store;

pub use store::{CompanyStore, initialization_status, initialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized,
    Forbidden,
    Invalid,
    Conflict,
    Missing,
    Capacity,
    Busy,
    Storage,
    PublicationUnconfirmed,
    ExistingCompany,
}
impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unauthorized => "CREDENTIAL_REQUIRED",
            Self::Forbidden => "MANAGE_OFFICE_REQUIRED",
            Self::Invalid => "INVALID_REQUEST",
            Self::Conflict => "ORIGINAL_REQUEST_CONFLICT",
            Self::Missing => "ORIGINAL_NOT_FOUND",
            Self::Capacity => "CAPACITY",
            Self::Busy => "COMPANY_WRITER_BUSY",
            Self::Storage => "PRIVATE_STORE_UNAVAILABLE",
            Self::PublicationUnconfirmed => "PUBLICATION_UNCONFIRMED",
            Self::ExistingCompany => "EXISTING_COMPANY_MIGRATION_REQUIRED",
        }
    }
    pub(crate) fn status(self) -> u16 {
        match self {
            Self::Unauthorized => 401,
            Self::Forbidden => 403,
            Self::Invalid => 400,
            Self::Conflict | Self::Capacity | Self::ExistingCompany => 409,
            Self::Missing => 404,
            Self::Busy | Self::Storage | Self::PublicationUnconfirmed => 503,
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for Error {}
pub(crate) type Result<T> = std::result::Result<T, Error>;
