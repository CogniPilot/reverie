//! Fixed existing namespaces, through original private readers and checked
//! directory scans. Unknown/active history is preserved and refuses setup.
use super::*;
use reverie_contracts::{
    reservation_engine::ReservationConfiguration,
    resource_actor::{ActorSetupDataError, actor_setup_history},
};
use std::{collections::BTreeSet, os::unix::fs::MetadataExt, path::PathBuf, rc::Rc};
mod digest;
mod error;
mod publication;
mod read;
mod resume;
mod retained_resume;
pub use error::ActorSetupHistoryError;
type HistoryResult<T> = std::result::Result<T, ActorSetupHistoryError>;

#[derive(Clone, Eq, PartialEq)]
struct Directory {
    path: PathBuf,
    stamp: crate::gpu_access::GpuFileStamp,
    group: u32,
    projection: [String; 5],
    names: Vec<String>,
    identity: native::private_goal::PathIdentity,
}
struct Record {
    path: PathBuf,
    stamp: Fingerprint,
    group: u32,
    digest: Option<[u8; 32]>,
}
struct Snapshot {
    directories: Vec<Directory>,
    records: Vec<Record>,
}
#[must_use = "retain the same original private read scopes through checked close"]
pub struct ActorSetupHistoryObservation {
    root: PathBuf,
    files: Option<PrivateBatch>,
    snapshot: Option<Snapshot>,
    primary: Option<Rc<ActorSetupHistoryError>>,
    cleanup: Option<Rc<ActorSetupHistoryError>>,
    attempted: bool,
    close_attempted: bool,
    bytes: usize,
    entries: usize,
    end: Instant,
    retained: Option<actor_setup_history::RetainedExpiredResumeData>,
    refresh: bool,
}
enum HistoryPurpose<'a> {
    SettledOnly,
    InitialActorSetup(&'a mut crate::worker_image::ImageMaintenanceLocks),
}
/// Borrowed closure of these original history readers only. A primary refusal
/// stays a refusal; this does not close R/service or authorize a publication.
pub struct ActorSetupHistoryClosed<'a> {
    _owner: &'a mut ActorSetupHistoryObservation,
}
impl ActorSetupHistoryObservation {
    pub fn capture(config: &ReservationConfiguration, end: Instant) -> HistoryResult<Self> {
        require(
            config
                .uid()
                .map_err(ActorSetupHistoryError::Configuration)?
                == native::uid(),
            "ACTOR_SETUP_HISTORY_OWNER",
        )?;
        let root = config
            .control_paths()
            .map_err(|_| ActorSetupHistoryError::Refused("ACTOR_SETUP_HISTORY_ROOT"))?
            .root()
            .clone();
        let root = native::python_path(&root.codepoints()).map_err(GoalCustodyError::from)?;
        Ok(Self {
            root,
            files: None,
            snapshot: None,
            primary: None,
            cleanup: None,
            attempted: false,
            close_attempted: false,
            bytes: 0,
            entries: 0,
            end,
            retained: None,
            refresh: false,
        })
    }
    pub fn observe_for_actor_refresh(
        &mut self,
        locks: &mut crate::worker_image::ImageMaintenanceLocks,
    ) -> std::result::Result<(), Rc<ActorSetupHistoryError>> {
        if self.attempted {
            return Err(Rc::new(ActorSetupHistoryError::Refused(
                "ACTOR_SETUP_HISTORY_ALREADY_OBSERVED",
            )));
        }
        self.refresh = true;
        self.observe_purpose(HistoryPurpose::InitialActorSetup(locks))
    }
    pub fn observe(&mut self) -> std::result::Result<(), Rc<ActorSetupHistoryError>> {
        self.observe_purpose(HistoryPurpose::SettledOnly)
    }
    pub fn observe_for_initial_actor_setup(
        &mut self,
        locks: &mut crate::worker_image::ImageMaintenanceLocks,
    ) -> std::result::Result<(), Rc<ActorSetupHistoryError>> {
        self.observe_purpose(HistoryPurpose::InitialActorSetup(locks))
    }
    fn observe_purpose(
        &mut self,
        purpose: HistoryPurpose<'_>,
    ) -> std::result::Result<(), Rc<ActorSetupHistoryError>> {
        if let Some(cause) = &self.primary {
            return Err(Rc::clone(cause));
        }
        if self.attempted {
            return Err(Rc::new(ActorSetupHistoryError::Refused(
                "ACTOR_SETUP_HISTORY_ALREADY_OBSERVED",
            )));
        }
        self.attempted = true;
        let body = self.read_snapshot(purpose);
        body.map_err(|cause| Rc::clone(self.primary.get_or_insert_with(|| Rc::new(cause))))
    }
    pub fn assert_current(&self) -> std::result::Result<(), Rc<ActorSetupHistoryError>> {
        if let Some(cause) = &self.primary {
            return Err(Rc::clone(cause));
        }
        if let Some(cause) = &self.cleanup {
            return Err(Rc::clone(cause));
        }
        self.metadata_current().map_err(Rc::new)
    }
    pub fn primary_error(&self) -> Option<&ActorSetupHistoryError> {
        self.primary.as_deref()
    }
    pub fn cleanup_error(&self) -> Option<&ActorSetupHistoryError> {
        self.cleanup.as_deref()
    }
    pub fn close(
        &mut self,
    ) -> std::result::Result<ActorSetupHistoryClosed<'_>, Rc<ActorSetupHistoryError>> {
        self.close_phase(publication::HistoryPhase::Before)
    }
    fn metadata_current(&self) -> HistoryResult<()> {
        self.time()?;
        self.assert_retained_expired()?;
        self.files
            .as_ref()
            .ok_or(ActorSetupHistoryError::Refused(
                "ACTOR_SETUP_HISTORY_NOT_OBSERVED",
            ))?
            .check()?;
        let snapshot = self
            .snapshot
            .as_ref()
            .ok_or(ActorSetupHistoryError::Refused(
                "ACTOR_SETUP_HISTORY_NOT_OBSERVED",
            ))?;
        for directory in &snapshot.directories {
            directory.assert_current()?;
        }
        for record in &snapshot.records {
            PrivateBatch::check_exact_private_json(&record.path, &record.stamp)?;
            let info = std::fs::symlink_metadata(&record.path).map_err(GoalCustodyError::from)?;
            require(info.gid() == record.group, "ACTOR_SETUP_HISTORY_CHANGED")?;
        }
        self.time()
    }
    fn time(&self) -> HistoryResult<()> {
        require(Instant::now() < self.end, "ACTOR_SETUP_HISTORY_DEADLINE")
    }
}
impl Drop for ActorSetupHistoryObservation {
    fn drop(&mut self) {
        if !self.close_attempted
            || self
                .primary
                .as_ref()
                .is_some_and(|cause| cause.has_unconfirmed_close())
            || self
                .cleanup
                .as_ref()
                .is_some_and(|cause| cause.has_unconfirmed_close())
        {
            std::mem::forget((
                self.files.take(),
                self.snapshot.take(),
                self.primary.take(),
                self.cleanup.take(),
            ));
        }
    }
}
impl Directory {
    fn assert_current(&self) -> HistoryResult<()> {
        let info = std::fs::symlink_metadata(&self.path).map_err(GoalCustodyError::from)?;
        require(
            info.is_dir()
                && crate::gpu_access::GpuFileStamp::of(&info) == self.stamp
                && info.gid() == self.group,
            "ACTOR_SETUP_HISTORY_CHANGED",
        )
    }
}
fn require(value: bool, code: &'static str) -> HistoryResult<()> {
    value
        .then_some(())
        .ok_or(ActorSetupHistoryError::Refused(code))
}
