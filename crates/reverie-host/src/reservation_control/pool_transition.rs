//! Original transition pending owner. No recovery-from-JSON constructor.
use super::*;
use crate::private_pending::{PendingError, PendingFile};
use reverie_contracts::reservation_control::PoolTransitionIntent;
use std::sync::{Arc, Mutex};
mod publication;
pub(crate) use publication::PoolRenameFence;
pub use publication::{
    PoolPublication, PoolPublicationCause, PoolPublicationFailure, PoolPublicationPrepared,
    PoolTerminal,
};

#[must_use = "retain the original pending/publication owner until checked terminal release"]
pub struct PoolTransitionPending {
    owner: Option<Box<PendingOwner>>,
}
struct PendingOwner {
    file: PendingFile,
    proof: Arc<PendingProof>,
    ledger: Arc<publication::FailureLedger>,
    publication: Option<publication::PublicationState>,
}
struct PendingProof {
    config: ReservationConfiguration,
    binding: ControlBinding,
    intent: Arc<PoolTransitionIntent>,
    path: std::path::PathBuf,
    stamp: native::PrivateFileStamp,
    unconfirmed: Mutex<Option<Arc<ObservationError>>>,
}
impl PoolTransitionPending {
    /// May leave durable partial evidence on Err. The application must retain
    /// its actual attempt record before entering this exclusive writer.
    pub fn establish(
        config: &ReservationConfiguration,
        binding: &ControlBinding,
        admission: &AdmissionLock,
        intent: Arc<PoolTransitionIntent>,
    ) -> Result<Self> {
        admission.assert_current(config, binding)?;
        intent
            .assert_configuration(config.configuration())
            .map_err(|_| ControlHostError::Refused("POOL_TRANSITION_CONFIGURATION_CHANGED"))?;
        let uid = config.uid()?;
        let paths = config.control_paths()?;
        let (directory, observed) = native::held_control_directory(&paths.binding().parent(), uid)?;
        if !binding
            .state_directory()
            .matches_native(observed.device, observed.inode)
        {
            return finish(
                Err(ControlHostError::Refused(
                    "RESERVATION_STATE_DIRECTORY_REBOUND",
                )),
                native::close(directory).map_err(Into::into),
            );
        }
        let path = native::python_path(&paths.pending().codepoints());
        let path = match path {
            Ok(path) => path,
            Err(error) => {
                return finish(
                    Err(error.into()),
                    native::close(directory).map_err(Into::into),
                );
            }
        };
        let file =
            PendingFile::create(directory, path, intent.bytes(), uid).map_err(pending_error)?;
        // The caller must store this actual published owner before its first
        // fallible readback; otherwise a failed read would lose its stamp.
        let proof = Arc::new(PendingProof {
            config: ReservationConfiguration::capture(config.configuration().clone()),
            binding: binding.clone(),
            intent,
            path: file.path().to_owned(),
            stamp: file.stamp().clone(),
            unconfirmed: Mutex::new(None),
        });
        Ok(Self {
            owner: Some(Box::new(PendingOwner {
                file,
                proof,
                ledger: Arc::new(publication::FailureLedger::default()),
                publication: None,
            })),
        })
    }
    fn owner(&self) -> &PendingOwner {
        self.owner.as_deref().expect("original pool pending owner")
    }
    fn owner_mut(&mut self) -> &mut PendingOwner {
        self.owner
            .as_deref_mut()
            .expect("original pool pending owner")
    }
    /// Fresh read only. Success is not a cleanup, admission or execution grant.
    pub fn assert_current(&self, config: &ReservationConfiguration) -> Result<()> {
        let owner = self.owner();
        owner.ledger.live()?;
        owner.proof.assert_known_close()?;
        // Preserve the denial-only API's original typed close refusal. The
        // paired publication methods own their separate first-failure latch.
        owner
            .proof
            .intent
            .assert_configuration(config.configuration())
            .map_err(|_| ControlHostError::Refused("POOL_TRANSITION_CONFIGURATION_CHANGED"))?;
        need(
            owner.file.unreleased(),
            "POOL_TRANSITION_REQUIRES_RECONCILIATION",
        )?;
        owner.proof.assert_current()
    }
}
impl PendingProof {
    fn assert_known_close(&self) -> Result<()> {
        let cause = self
            .unconfirmed
            .lock()
            .map_err(|_| ControlHostError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?;
        match cause.as_ref() {
            Some(cause) => Err(ControlHostError::PoolTransitionClose(cause.clone())),
            None => Ok(()),
        }
    }
    // Publication changes the configuration, never this original inode/byte proof.
    fn assert_current(&self) -> Result<()> {
        let mut unconfirmed = self
            .unconfirmed
            .lock()
            .map_err(|_| ControlHostError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?;
        if let Some(cause) = &*unconfirmed {
            return Err(ControlHostError::PoolTransitionClose(cause.clone()));
        }
        let path = native::python_path(&self.config.control_paths()?.pending().codepoints())?;
        need(path == self.path, "POOL_TRANSITION_PENDING_CHANGED")?;
        let before = native::PrivateFileStamp::of(&fs::symlink_metadata(&path)?);
        need(before == self.stamp, "POOL_TRANSITION_PENDING_CHANGED")?;
        let uid = self.config.uid()?;
        let bytes = match native::observe(&path, 4096, |info| private(info, uid)) {
            Ok(bytes) => bytes,
            Err(cause) if cause.has_unconfirmed_close() => {
                let cause = Arc::new(cause);
                *unconfirmed = Some(cause.clone());
                return Err(ControlHostError::PoolTransitionClose(cause));
            }
            Err(cause) => return Err(cause.into()),
        };
        need(
            bytes == self.intent.bytes()
                && native::PrivateFileStamp::of(&fs::symlink_metadata(&path)?) == before,
            "POOL_TRANSITION_PENDING_CHANGED",
        )
    }
}
impl Drop for PoolTransitionPending {
    fn drop(&mut self) {
        if self
            .owner
            .as_ref()
            .is_some_and(|owner| !owner.file.confirmed())
        {
            std::mem::forget(self.owner.take());
        }
    }
}
fn pending_error(error: PendingError) -> ControlHostError {
    match error {
        PendingError::Io(error) => error.into(),
        PendingError::Native(error) => error.into(),
        PendingError::Finalized { primary, secondary } => ControlHostError::Finalization {
            primary: Box::new(pending_error(*primary)),
            secondary: Box::new(pending_error(*secondary)),
        },
        PendingError::PublicationUnknown(error) => {
            ControlHostError::PoolReleaseUnknown(Box::new(pending_error(*error)))
        }
        PendingError::Parent
        | PendingError::Private
        | PendingError::AlreadyAttempted
        | PendingError::Changed
        | PendingError::Deadline => {
            ControlHostError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION")
        }
    }
}
fn finish<T>(body: Result<T>, closed: Result<()>) -> Result<T> {
    match (body, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(ControlHostError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
