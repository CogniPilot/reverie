//! Stopped original Offer-service owner for one high-threshold DATA revision.
use super::*;
use crate::{
    worker_image::{ClosedImageMaintenance, ImageMaintenanceFailure, ImageMaintenanceLocks},
    worker_service::{
        ClosedImageServiceMaintenance, ImageServiceMaintenance, NativeWorkerServiceRole,
        StoppedServiceFailure, StoppedServiceOrigin, StoppedWorkerService,
        capture_stopped_worker_service_for_role,
    },
};
use reverie_core::{ids::ProfileEmployeeId, operations::JournalDigest};
use std::fmt;
mod pending_recovery;
mod prepare;
enum RevisionPurpose {
    Highs,
    RebaseWebsite,
    RecoverPending(Box<pending_recovery::PendingRecovery>),
}
impl RevisionPurpose {
    fn pending(&self) -> Option<&pending_recovery::PendingRecovery> {
        match self {
            Self::RecoverPending(owner) => Some(owner),
            _ => None,
        }
    }
    fn pending_mut(&mut self) -> Option<&mut pending_recovery::PendingRecovery> {
        match self {
            Self::RecoverPending(owner) => Some(owner),
            _ => None,
        }
    }
}
mod publication;
pub(super) mod retirement;
struct RevisionOwner {
    nominal: Box<NominationOwner>,
    expected: JournalDigest,
    default: u32,
    overrides: Vec<(ProfileEmployeeId, u32)>,
    next: Option<PoolInstallationRequestData>,
    stopped: Option<StoppedWorkerService>,
    service: Option<ImageServiceMaintenance>,
    service_origin: Option<StoppedServiceOrigin>,
    closed_service: Option<ClosedImageServiceMaintenance>,
    service_failure: Option<Box<StoppedServiceFailure>>,
    locks: Option<ImageMaintenanceLocks>,
    closed_locks: Option<ClosedImageMaintenance>,
    lock_failure: Option<Box<ImageMaintenanceFailure>>,
    publication: Option<publication::Publication>,
    attempted: bool,
    retirement: Option<retirement::Retirement>,
    purpose: RevisionPurpose,
}
#[must_use = "retain the same revision owner; a partial publication is not replayable"]
pub struct PoolNominationRevisionFailure {
    owner: Option<Box<RevisionOwner>>,
    cause: Option<PoolNominationError>,
}
impl PoolNominationRevisionFailure {
    pub fn cause(&self) -> &PoolNominationError {
        self.cause.as_ref().expect("same cause")
    }
}
impl fmt::Debug for PoolNominationRevisionFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("PoolNominationRevisionFailure")
            .field(&self.cause())
            .finish()
    }
}
impl fmt::Display for PoolNominationRevisionFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.cause().fmt(f)
    }
}
impl std::error::Error for PoolNominationRevisionFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.cause())
    }
}
impl Drop for PoolNominationRevisionFailure {
    fn drop(&mut self) {
        std::mem::forget((self.owner.take(), self.cause.take()));
    }
}
pub use retirement::retire_failed_os_pool_installation;
pub fn revise_os_pool_nomination(
    source: Option<&Path>,
    config: &EffectiveWorkerConfig,
    expected: &JournalDigest,
    default: u32,
    overrides: Vec<(ProfileEmployeeId, u32)>,
    runtime: WorkerRuntime,
    end: Instant,
) -> std::result::Result<PoolNominationPublished, Box<PoolNominationRevisionFailure>> {
    let owner = Box::new(RevisionOwner {
        nominal: Box::new(NominationOwner::capture(
            source,
            config,
            Path::new(""),
            runtime,
            end,
            InputPurpose::Request,
        )),
        expected: expected.clone(),
        default,
        overrides,
        next: None,
        stopped: None,
        service: None,
        service_origin: None,
        closed_service: None,
        service_failure: None,
        locks: None,
        closed_locks: None,
        lock_failure: None,
        publication: None,
        attempted: false,
        retirement: None,
        purpose: RevisionPurpose::Highs,
    });
    finish_revision(owner)
}
/// Rebind proposal DATA after supported website replacement, only with no
/// provider/controller/parent/endpoint/prepared-birth and all staff stopped.
pub fn rebase_uninstalled_os_pool_nomination(
    source: Option<&Path>,
    config: &EffectiveWorkerConfig,
    expected: &JournalDigest,
    runtime: WorkerRuntime,
    end: Instant,
) -> std::result::Result<PoolNominationPublished, Box<PoolNominationRevisionFailure>> {
    finish_revision(Box::new(RevisionOwner {
        nominal: Box::new(NominationOwner::capture(
            source,
            config,
            Path::new(""),
            runtime,
            end,
            InputPurpose::Request,
        )),
        expected: expected.clone(),
        default: 0,
        overrides: Vec::new(),
        next: None,
        stopped: None,
        service: None,
        service_origin: None,
        closed_service: None,
        service_failure: None,
        locks: None,
        closed_locks: None,
        lock_failure: None,
        publication: None,
        attempted: false,
        retirement: None,
        purpose: RevisionPurpose::RebaseWebsite,
    }))
}
pub fn recover_uninstalled_os_pool_pending(
    source: Option<&Path>,
    config: &EffectiveWorkerConfig,
    expected: &JournalDigest,
    pending_digest: &JournalDigest,
    runtime: WorkerRuntime,
    end: Instant,
) -> std::result::Result<PoolNominationPublished, Box<PoolNominationRevisionFailure>> {
    finish_revision(Box::new(RevisionOwner {
        nominal: Box::new(NominationOwner::capture(
            source,
            config,
            Path::new(""),
            runtime,
            end,
            InputPurpose::Request,
        )),
        expected: expected.clone(),
        default: 0,
        overrides: Vec::new(),
        next: None,
        stopped: None,
        service: None,
        service_origin: None,
        closed_service: None,
        service_failure: None,
        locks: None,
        closed_locks: None,
        lock_failure: None,
        publication: None,
        attempted: false,
        retirement: None,
        purpose: RevisionPurpose::RecoverPending(Box::new(
            pending_recovery::PendingRecovery::capture(pending_digest.clone()),
        )),
    }))
}

fn finish_revision(
    mut owner: Box<RevisionOwner>,
) -> std::result::Result<PoolNominationPublished, Box<PoolNominationRevisionFailure>> {
    let result = owner.run();
    match result {
        Ok(result) => Ok(result),
        Err(primary) => {
            let cause = match owner.close_components() {
                Ok(()) => primary,
                Err(cleanup) => {
                    PoolNominationError::Finalization(Box::new(primary), Box::new(cleanup))
                }
            };
            Err(Box::new(PoolNominationRevisionFailure {
                owner: Some(owner),
                cause: Some(cause),
            }))
        }
    }
}
impl RevisionOwner {
    fn run(&mut self) -> Result<PoolNominationPublished> {
        self.prepare()?;
        self.begin_fence()?;
        self.publication = Some(publication::Publication::empty());
        self.publication
            .as_mut()
            .expect("retained before opening")
            .capture(&self.nominal)?;
        self.assert_before()?;
        self.attempted = true;
        if let Some(retirement) = &mut self.retirement {
            retirement.publish(
                &mut self.nominal,
                self.publication.as_ref().expect("owned history"),
                self.locks.as_mut().expect("same locks"),
                self.service.as_ref().expect("same IMAGE"),
            )?;
        }
        if !matches!(self.purpose, RevisionPurpose::RecoverPending(_)) {
            self.publication
                .as_mut()
                .expect("original file owners")
                .publish(
                    &self.nominal,
                    self.next.as_ref().expect("checked next DATA"),
                    self.locks.as_mut().expect("same locks"),
                    self.service.as_ref().expect("same IMAGE"),
                )?;
        } else {
            self.publication
                .as_ref()
                .expect("same history")
                .assert_unchanged(&self.nominal)?;
        }
        if self.purpose.pending().is_some() {
            self.assert_uninstalled()?;
            self.purpose
                .pending_mut()
                .expect("original pending owner")
                .archive(
                    &self.nominal,
                    self.publication.as_ref().expect("same history"),
                    self.locks.as_mut().expect("same IMAGE locks"),
                    self.service.as_ref().expect("same stopped service"),
                )?;
        }
        self.assert_after()?;
        self.close_components()?;
        self.assert_after_files()?;
        self.closed_locks
            .as_ref()
            .expect("checked locks close")
            .assert_current()?;
        let source = self.nominal.source.as_ref().expect("original source");
        let origin = self.service_origin.as_ref().expect("original IMAGE origin");
        let closed = self
            .closed_service
            .as_ref()
            .expect("same known service closure");
        need(
            closed.source() == source && closed.belongs_to(origin),
            "POOL_NOMINATION_SERVICE_RECEIPT_CHANGED",
        )?;
        let service = self.closed_service.take().expect("checked service close");
        let closed = service
            .release()
            .map_err(|cause| self.keep_service(cause))?;
        let source = self.nominal.source.as_ref().expect("original source");
        let origin = self.service_origin.as_ref().expect("original IMAGE origin");
        need(
            closed.source() == source && closed.belongs_to(origin),
            "POOL_NOMINATION_SERVICE_RECEIPT_CHANGED",
        )?;
        let next = self.next.as_ref().expect("same new nomination");
        Ok(PoolNominationPublished {
            path: self.nominal.selection.clone(),
            digest: next.digest().as_str().to_owned(),
            canonical: next.canonical_bytes().to_vec(),
            proposed_from_hard: Vec::new(),
        })
    }
    fn begin_fence(&mut self) -> Result<()> {
        need(
            !self.attempted,
            "POOL_NOMINATION_REVISION_ALREADY_ATTEMPTED",
        )?;
        let stopped = self.stopped.take().expect("same stopped Offer proof");
        self.service = Some(
            stopped
                .begin_image_transition()
                .map_err(|cause| self.keep_service(cause))?,
        );
        self.service_origin = Some(self.service.as_ref().expect("same IMAGE owner").origin());
        Ok(())
    }
    fn keep_service(&mut self, cause: Box<StoppedServiceFailure>) -> PoolNominationError {
        let code = cause.primary_error().code();
        self.service_failure = Some(cause);
        PoolNominationError::Refused(code)
    }
    fn close_components(&mut self) -> Result<()> {
        let files = self
            .publication
            .as_mut()
            .map_or(Ok(()), publication::Publication::close);
        let retirement = self.retirement.as_mut().map_or(Ok(()), |owner| {
            owner.close(&self.nominal.runtime, self.nominal.end)
        });
        let pending = self
            .purpose
            .pending_mut()
            .map_or(Ok(()), pending_recovery::PendingRecovery::close);
        let nominal = finalized(self.nominal.close(), pending);
        let locks = if let Some(locks) = self.locks.take() {
            match locks.close() {
                Ok(closed) => {
                    self.closed_locks = Some(closed);
                    Ok(())
                }
                Err(cause) => {
                    let code = cause.cause().code();
                    self.lock_failure = Some(cause);
                    Err(PoolNominationError::Refused(code))
                }
            }
        } else {
            Ok(())
        };
        let service = if let Some(service) = self.service.take() {
            match service.close() {
                Ok(closed) => {
                    self.closed_service = Some(closed);
                    Ok(())
                }
                Err(cause) => Err(self.keep_service(cause)),
            }
        } else if let Some(stopped) = self.stopped.take() {
            stopped
                .finish()
                .map(|_| ())
                .map_err(|cause| self.keep_service(cause))
        } else {
            Ok(())
        };
        finalized(
            finalized(finalized(files, retirement), nominal),
            finalized(locks, service),
        )
    }
    fn assert_before(&mut self) -> Result<()> {
        if let Some(pending) = self.purpose.pending() {
            pending.assert_before(&self.nominal)?;
        }
        self.nominal.assert_preflight()?;
        self.assert_uninstalled()?;
        self.nominal
            .derived
            .as_ref()
            .expect("same native company")
            .assert_metadata(&self.nominal.config)?;
        self.locks
            .as_mut()
            .expect("same locks")
            .assert_held_current()?;
        self.service.as_mut().expect("same IMAGE").revalidate()?;
        self.nominal.assert_preflight()
    }
    fn assert_after(&mut self) -> Result<()> {
        self.assert_uninstalled()?;
        self.nominal
            .derived
            .as_ref()
            .expect("same company")
            .assert_metadata(&self.nominal.config)?;
        self.nominal.assert_source()?;
        self.locks
            .as_mut()
            .expect("same locks")
            .assert_held_current()?;
        self.service.as_mut().expect("same IMAGE").revalidate()?;
        self.assert_after_files()
    }
    fn assert_uninstalled(&mut self) -> Result<()> {
        if let Some(retirement) = &mut self.retirement {
            retirement.assert_current(&mut self.nominal)
        } else {
            self.nominal
                .derived
                .as_mut()
                .expect("original derivation")
                .assert_uninstalled(
                    &self.nominal.runtime,
                    self.nominal.request.as_ref().expect("old request").policy(),
                )
        }
    }
    fn assert_after_files(&self) -> Result<()> {
        if let Some(pending) = self.purpose.pending() {
            pending.assert_after(
                &self.nominal,
                self.publication.as_ref().expect("same history"),
            )?;
        }
        if let Some(retirement) = &self.retirement {
            retirement.assert_metadata()?;
        }
        self.nominal.current()?;
        self.nominal
            .derived
            .as_ref()
            .expect("same retained prepared DATA")
            .assert_metadata(&self.nominal.config)?;
        need(
            self.nominal
                .stores
                .as_ref()
                .expect("same stores")
                .unchanged()?,
            "POOL_NOMINATION_PROTECTED_STORE_CHANGED",
        )?;
        let publication = self.publication.as_ref().expect("original publication");
        if matches!(self.purpose, RevisionPurpose::RecoverPending(_)) {
            publication.assert_unchanged(&self.nominal)
        } else {
            publication.assert_published(&self.nominal, self.next.as_ref().expect("new DATA"))
        }
    }
}
