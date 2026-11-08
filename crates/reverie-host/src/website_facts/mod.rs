//! Read-only same-kernel website observations. Neither installer-selected DATA
//! nor successful metadata requests authenticate a website or authorize work.
mod alias;
mod code;
mod engine;
mod files;
mod input;
mod process;
#[cfg(test)]
mod tests;
mod transport;
use crate::native;
pub use alias::{ImmutableAliasObserver, ObservedCodeAlias};
pub use code::{ImmutableCodeObserver, ObservedCodeFile};
pub use input::{
    ImmutableInputKind, ImmutableInputObserver, ObservedBrokerProgram, ObservedImmutableInput,
    ObservedNativeClient,
};
#[cfg(test)]
pub(crate) use process::tests::metadata as process_test_metadata;
pub use process::{PeerInitSnapshot, PeerProcessSnapshot, ProcessSnapshot, WebsiteProcessObserver};
use reverie_contracts::resource_actor::{EngineMetadata, EngineSelection};
use reverie_core::operations::JournalDigest;
use std::{fmt, io, path::PathBuf};

#[derive(Debug)]
pub enum WebsiteFactsError {
    Refused(&'static str),
    Io(io::Error),
    Channel(crate::worker_reports::WorkerReportError),
    Cleanup,
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl WebsiteFactsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Io(_) => "ENGINE_METADATA_UNAVAILABLE",
            Self::Channel(error) => error.code(),
            Self::Cleanup => "ENGINE_METADATA_CLOSE_UNCONFIRMED",
            Self::Finalization { .. } => "ENGINE_METADATA_FINALIZATION",
        }
    }
}
impl fmt::Display for WebsiteFactsError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for WebsiteFactsError {}
impl From<io::Error> for WebsiteFactsError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<crate::worker_reports::WorkerReportError> for WebsiteFactsError {
    fn from(value: crate::worker_reports::WorkerReportError) -> Self {
        Self::Channel(value)
    }
}
type Result<T> = std::result::Result<T, WebsiteFactsError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(WebsiteFactsError::Refused(code))
    }
}
/// Closed metadata routes; no user URL, arbitrary request method, body,
/// container exec, mutation, proxy, environment or command callback exists.
pub enum WebsiteMetadataRoute {
    Info,
    Containers,
    Container(JournalDigest),
    Image(JournalDigest),
}
impl WebsiteMetadataRoute {
    fn path(&self) -> String {
        match self {
            Self::Info => "/info".into(),
            Self::Containers => "/containers/json?all=1".into(),
            Self::Container(id) => format!("/containers/{}/json", id.as_str()),
            Self::Image(id) => format!("/images/sha256:{}/json", id.as_str()),
        }
    }
}
/// Holds only selected socket identity DATA and a local read-only transport.
/// A Q owner must separately verify immutable image/programs, kernel peer,
/// protected private installation, current cookie and actual service origin.
pub struct WebsiteMetadataObserver {
    socket: PathBuf,
    identity: [u64; 4],
    engine_id: String,
    runtime: tokio::runtime::Runtime,
    close_uncertain: bool,
}
