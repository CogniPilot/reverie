//! Fixed existing pending-control leaf. No release or recovery-from-JSON API.
use super::*;
use crate::private_pending::{PendingError, PendingFile};
use reverie_contracts::reservation_control::PoolTransitionIntent;
use std::sync::{Arc, Mutex};

pub struct PoolTransitionPending {
    file: PendingFile,
    intent: Arc<PoolTransitionIntent>,
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
        Ok(Self {
            file,
            intent,
            unconfirmed: Mutex::new(None),
        })
    }
    /// Fresh read only. Success is not a cleanup, admission or execution grant.
    pub fn assert_current(&self, config: &ReservationConfiguration) -> Result<()> {
        let mut unconfirmed = self
            .unconfirmed
            .lock()
            .map_err(|_| ControlHostError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?;
        if let Some(cause) = &*unconfirmed {
            return Err(ControlHostError::PoolTransitionClose(cause.clone()));
        }
        self.intent
            .assert_configuration(config.configuration())
            .map_err(|_| ControlHostError::Refused("POOL_TRANSITION_CONFIGURATION_CHANGED"))?;
        need(
            self.file.unreleased(),
            "POOL_TRANSITION_REQUIRES_RECONCILIATION",
        )?;
        let path = native::python_path(&config.control_paths()?.pending().codepoints())?;
        need(path == self.file.path(), "POOL_TRANSITION_PENDING_CHANGED")?;
        let before = native::PrivateFileStamp::of(&fs::symlink_metadata(&path)?);
        need(
            &before == self.file.stamp(),
            "POOL_TRANSITION_PENDING_CHANGED",
        )?;
        let uid = config.uid()?;
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
fn pending_error(error: PendingError) -> ControlHostError {
    match error {
        PendingError::Io(error) => error.into(),
        PendingError::Native(error) => error.into(),
        PendingError::Finalized { primary, secondary } => ControlHostError::Finalization {
            primary: Box::new(pending_error(*primary)),
            secondary: Box::new(pending_error(*secondary)),
        },
        PendingError::PublicationUnknown(error) => pending_error(*error),
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
