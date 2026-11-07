//! Existing-only installed private facts observation. No provisioning, engine
//! access, process authentication, current-owner grant or launch authority.
#[cfg(test)]
mod tests;
use crate::{
    goal_custody::{
        GoalCustodyError,
        files::{Fingerprint, PrivateBatch},
    },
    native,
};
use reverie_contracts::{
    resource_actor::{InstalledFactsDocument, ResourceActorDataError, ResourceActorSettings},
    worker_config::EffectiveWorkerConfig,
};
use std::{fmt, path::Path, time::Instant};

#[derive(Debug)]
pub enum ResourceFactsError {
    Refused(&'static str),
    Private(GoalCustodyError),
    Data(ResourceActorDataError),
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
            Self::Finalization { .. } => "RESOURCE_INSTALL_FINALIZATION",
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
struct BoundDocument {
    path: std::path::PathBuf,
    stamp: Fingerprint,
    raw: Vec<u8>,
    identities: Vec<(std::path::PathBuf, native::private_goal::PathIdentity)>,
}
#[derive(Default)]
#[must_use = "retain the original observer and actor hold after uncertain close"]
pub struct InstalledFactsObserver {
    original: Option<BoundDocument>,
    close_uncertain: bool,
}
impl InstalledFactsObserver {
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
            selected.uid() == native::uid(),
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
        Ok(document)
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
            },
        ))
    }
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
