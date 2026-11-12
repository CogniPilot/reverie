//! Existing-only installed private facts observation. No provisioning, engine
//! access, process authentication, current-owner grant or launch authority.
mod fixed_reference;
mod rebind;
#[cfg(test)]
pub(crate) mod tests;
pub use fixed_reference::compiled_actor_image_provenance_reference;
mod setup;
use crate::{
    goal_custody::{
        GoalCustodyError,
        files::{Fingerprint, PrivateBatch},
    },
    native,
};
pub use rebind::{ActorRebindPlan, ActorRebound};
use reverie_contracts::{
    resource_actor::{InstalledFactsDocument, ResourceActorDataError, ResourceActorSettings},
    worker_config::EffectiveWorkerConfig,
};
pub use setup::{ActorSetupFacts, ActorSetupFactsError};
pub use setup::{ActorSetupHistoryClosed, ActorSetupHistoryError, ActorSetupHistoryObservation};
use std::{fmt, path::Path, time::Instant};

#[derive(Debug)]
pub enum ResourceFactsError {
    Refused(&'static str),
    Private(GoalCustodyError),
    Data(ResourceActorDataError),
    Writer(Box<crate::gpu_access::GpuHostError>),
    Finalization {
        primary: Box<Self>,
        cleanup: Box<Self>,
    },
}
impl ResourceFactsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Private(_) => "RESOURCE_INSTALL_PRIVATE_ENTRY",
            Self::Data(error) => error.code(),
            Self::Writer(error) => error.code(),
            Self::Finalization { .. } => "RESOURCE_INSTALL_FINALIZATION",
        }
    }
    pub fn has_unconfirmed_close(&self) -> bool {
        match self {
            Self::Private(GoalCustodyError::Cleanup) => true,
            Self::Private(GoalCustodyError::Native(error)) => error.has_unconfirmed_close(),
            Self::Writer(error) => error.has_unconfirmed_close(),
            Self::Finalization { primary, cleanup } => {
                primary.has_unconfirmed_close() || cleanup.has_unconfirmed_close()
            }
            _ => false,
        }
    }
}
impl fmt::Display for ResourceFactsError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for ResourceFactsError {}
impl From<GoalCustodyError> for ResourceFactsError {
    fn from(error: GoalCustodyError) -> Self {
        Self::Private(error)
    }
}
impl From<ResourceActorDataError> for ResourceFactsError {
    fn from(error: ResourceActorDataError) -> Self {
        Self::Data(error)
    }
}
type Result<T> = std::result::Result<T, ResourceFactsError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(ResourceFactsError::Refused(code))
    }
}
#[derive(Clone, Eq, PartialEq)]
struct BoundDocument {
    path: std::path::PathBuf,
    stamp: Fingerprint,
    raw: Vec<u8>,
    identities: Vec<(std::path::PathBuf, native::private_goal::PathIdentity)>,
    domain: reverie_core::operations::JournalDigest,
    end: Instant,
}
#[derive(Default)]
#[must_use = "retain the original observer and actor hold after uncertain close"]
pub struct InstalledFactsObserver {
    original: Option<BoundDocument>,
    close_uncertain: bool,
    identity: std::sync::Arc<()>,
}
impl InstalledFactsObserver {
    pub fn assert_finalized(&self) -> Result<()> {
        need(!self.close_uncertain, "RESOURCE_INSTALL_CLOSE_UNCONFIRMED")
    }
    /// Returned fields remain DATA. Only a later authenticating factory may
    /// join these with immutable files, actual engine/site/peer and owner.
    pub fn observe(
        &mut self,
        config: &EffectiveWorkerConfig,
        end: Instant,
    ) -> Result<InstalledFactsDocument> {
        need(!self.close_uncertain, "RESOURCE_INSTALL_CLOSE_UNCONFIRMED")?;
        check(end)?;
        let selected = ResourceActorSettings::capture(config)?;
        need(
            selected.uid() == native::uid() && selected.gid() == nix::unistd::getgid().as_raw(),
            "ORDINARY_OWNER_WEBSITE_REQUIRED",
        )?;
        let path = native::python_path(&selected.path().codepoints())
            .map_err(|_| ResourceFactsError::Refused("RESOURCE_INSTALL_FIXED_PATH"))?;
        let mut files = PrivateBatch::new()?;
        let body = self.read(&mut files, &path, &selected, end);
        let closed = files.close().map_err(ResourceFactsError::from);
        self.close_uncertain |= closed.is_err();
        let (document, bound) = finalized(body, closed)?;
        // No descriptor acquisition follows this final metadata-only bracket.
        files.check()?;
        PrivateBatch::check_exact_private_json(&bound.path, &bound.stamp)?;
        check(end)?;
        self.original = Some(bound);
        self.assert_metadata(config, end)?;
        Ok(document)
    }
    /// Recheck this observer's original installation using metadata only. No
    /// descriptor, engine request or process observation follows a caller's
    /// final native bracket. This does not establish current owner authority.
    pub fn assert_metadata(&self, config: &EffectiveWorkerConfig, end: Instant) -> Result<()> {
        need(!self.close_uncertain, "RESOURCE_INSTALL_CLOSE_UNCONFIRMED")?;
        check(end)?;
        let bound = self
            .original
            .as_ref()
            .ok_or(ResourceFactsError::Refused("RESOURCE_INSTALL_NOT_OBSERVED"))?;
        let selected = ResourceActorSettings::capture(config)?;
        need(
            selected.uid() == native::uid()
                && selected.gid() == nix::unistd::getgid().as_raw()
                && selected.domain() == &bound.domain
                && native::python_path(&selected.path().codepoints())
                    .map_err(|_| ResourceFactsError::Refused("RESOURCE_INSTALL_FIXED_PATH"))?
                    == bound.path,
            "RESOURCE_INSTALL_CHANGED",
        )?;
        bound.assert_paths()?;
        check(end)
    }
    fn read(
        &self,
        files: &mut PrivateBatch,
        path: &Path,
        selected: &ResourceActorSettings,
        end: Instant,
    ) -> Result<(InstalledFactsDocument, BoundDocument)> {
        let pending = path.with_file_name("resource-actor.installing.json");
        need(
            files.inspect(&pending, false, true)?.is_none(),
            "RESOURCE_INSTALL_PENDING_REQUIRES_INSPECTION",
        )?;
        let (stamp, raw) = files.read_exact_private_json(path)?;
        let identities = files.identities();
        if let Some(original) = &self.original {
            need(
                original.path == path
                    && original.stamp == stamp
                    && original.raw == raw
                    && original.identities == identities,
                "RESOURCE_INSTALL_CHANGED",
            )?;
        }
        let document = InstalledFactsDocument::decode(&raw)?;
        selected.require_document(&document)?;
        files.check()?;
        check(end)?;
        Ok((
            document,
            BoundDocument {
                path: path.to_owned(),
                stamp,
                raw,
                identities,
                domain: selected.domain().clone(),
                end,
            },
        ))
    }
}
/// Fresh one-use challenge DATA. Only the actual Q producer can bind this to
/// its protected channel, immutable request and current owner response.
pub fn fresh_owner_nonce() -> Result<reverie_core::operations::JournalId> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| ResourceFactsError::Refused("RESOURCE_OWNER_RANDOM_UNAVAILABLE"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(reverie_core::operations::JournalId::parse(&format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
    .expect("random UUIDv4"))
}
fn check(end: Instant) -> Result<()> {
    need(Instant::now() < end, "RESOURCE_INSTALL_DEADLINE")
}
fn finalized<T>(body: Result<T>, closed: Result<()>) -> Result<T> {
    match (body, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(cleanup)) => Err(ResourceFactsError::Finalization {
            primary: Box::new(primary),
            cleanup: Box::new(cleanup),
        }),
    }
}
