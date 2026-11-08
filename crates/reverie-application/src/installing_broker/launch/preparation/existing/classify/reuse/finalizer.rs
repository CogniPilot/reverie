//! Original finally ordering over the whole actual accepted reuse owner.
use super::*;
use crate::installing_broker::launch::preparation::cold::ColdFinalizationFailure;
use crate::installing_broker::launch::preparation::finalization::CleanupBudget;
use reverie_host::worker_laptop::ExistingStorageObservation;
mod reconciliation;
mod registration;
#[cfg(test)]
thread_local! {
    pub(super) static REGISTRATION_PAUSE: std::cell::RefCell<Option<crate::test_process::PausePoint<()>>> = const { std::cell::RefCell::new(None) };
}
enum Owner<'a> {
    Native {
        retained: RetainedReuse<'a>,
        session: Option<ViewerSession>,
    },
    Restored(Box<RestoredReuse<'a>>),
    Transferred(ReuseScope<'a>),
    Classified(Box<ColdFinalizationFailure<'a>>),
}
#[derive(Debug)]
enum Error {
    Storage(ExistingStorageError),
    Gate(GateError),
    Transport(reverie_host::worker_reports::WorkerReportError),
}
#[must_use = "cleanup uncertainty retains the actual resource and counted handler hold"]
pub struct ReuseFinalizationFailure<'a> {
    owner: Owner<'a>,
    primary: Option<Error>,
    errors: Vec<Error>,
    bookkeeping: Option<(bool, bool)>,
}
/// Handler cleanup only. A retained running laptop is owned by the original
/// installing registry; this report grants no global shutdown/capacity proof.
#[derive(Debug)]
pub struct ReuseHandlerClosed {
    completed: bool,
    storage_retained: bool,
    primary: Option<Error>,
    history: Vec<Error>,
}
impl ReuseHandlerClosed {
    pub fn primary_error(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.primary
            .as_ref()
            .or_else(|| self.history.first())
            .map(Error::as_error)
    }
    pub fn completed(&self) -> bool {
        self.completed
    }
    pub fn storage_retained(&self) -> bool {
        self.storage_retained
    }
}
struct Finalizer<'a> {
    owner: Owner<'a>,
    primary: Option<Error>,
    errors: Vec<Error>,
    completed: bool,
    target: Option<WorkerContainerName>,
}
impl<'a> Owner<'a> {
    fn scope(&self) -> &ReuseScope<'a> {
        match self {
            Self::Native { retained, .. } => &retained.scope,
            Self::Restored(owner) => &owner.scope,
            Self::Transferred(scope) => scope,
            Self::Classified(_) => unreachable!("classified prefix is never a native finalizer"),
        }
    }
    fn scope_mut(&mut self) -> &mut ReuseScope<'a> {
        match self {
            Self::Native { retained, .. } => &mut retained.scope,
            Self::Restored(owner) => &mut owner.scope,
            Self::Transferred(scope) => scope,
            Self::Classified(_) => unreachable!("classified prefix is never a native finalizer"),
        }
    }
}
impl<'a> ViewingReuse<'a> {
    /// Invoke after EVERY relay result, including EOF, malformed receipts and
    /// errors. Fresh is_file classification never depends on an earlier X.
    pub fn finalize(
        self,
        end: Instant,
    ) -> Result<ReuseHandlerClosed, Box<ReuseFinalizationFailure<'a>>> {
        self.finalize_budget(CleanupBudget::Bounded(end))
    }
    pub fn finalize_for_worker(
        self,
    ) -> Result<ReuseHandlerClosed, Box<ReuseFinalizationFailure<'a>>> {
        self.finalize_budget(CleanupBudget::Worker)
    }
    fn finalize_budget(
        self,
        budget: CleanupBudget,
    ) -> Result<ReuseHandlerClosed, Box<ReuseFinalizationFailure<'a>>> {
        let Self { owner, session } = self;
        finish(
            Owner::Native {
                retained: owner.retained,
                session: Some(session),
            },
            None,
            Vec::new(),
            budget,
        )
    }
}
impl<'a> AllocationClosedReuse<'a> {
    /// Also covers a completion that appears before any viewer job exists.
    pub fn finalize(
        self,
        end: Instant,
    ) -> Result<ReuseHandlerClosed, Box<ReuseFinalizationFailure<'a>>> {
        self.finalize_budget(CleanupBudget::Bounded(end))
    }
    pub fn finalize_for_worker(
        self,
    ) -> Result<ReuseHandlerClosed, Box<ReuseFinalizationFailure<'a>>> {
        self.finalize_budget(CleanupBudget::Worker)
    }
    fn finalize_budget(
        self,
        budget: CleanupBudget,
    ) -> Result<ReuseHandlerClosed, Box<ReuseFinalizationFailure<'a>>> {
        finish(
            Owner::Native {
                retained: self.retained,
                session: None,
            },
            None,
            Vec::new(),
            budget,
        )
    }
}
impl<'a> ReuseViewerFailure<'a> {
    pub fn finalize(
        self,
        end: Instant,
    ) -> Result<ReuseHandlerClosed, Box<ReuseFinalizationFailure<'a>>> {
        self.finalize_budget(CleanupBudget::Bounded(end))
    }
    pub fn finalize_for_worker(
        self,
    ) -> Result<ReuseHandlerClosed, Box<ReuseFinalizationFailure<'a>>> {
        self.finalize_budget(CleanupBudget::Worker)
    }
    fn finalize_budget(
        self,
        budget: CleanupBudget,
    ) -> Result<ReuseHandlerClosed, Box<ReuseFinalizationFailure<'a>>> {
        let error = match self.cause {
            Cause::Storage(error) => Error::Storage(error),
            Cause::Gate(error) => Error::Gate(error),
            Cause::Refused(code) => Error::Storage(ExistingStorageError::Refused(code)),
        };
        let mut primary = Some(error);
        let mut errors = Vec::new();
        let owner = match self.owner {
            FailureOwner::Classified(owner) => {
                // Consume the WHOLE classified scope in cleanup only. The
                // actual running inspection never becomes a Cold-create target.
                let closed = match budget {
                    CleanupBudget::Bounded(end) => owner.finalize_classified(end),
                    CleanupBudget::Worker => owner.finalize_classified_for_worker(),
                };
                return match closed {
                    Ok(closed) => Ok(ReuseHandlerClosed {
                        completed: closed.completed(),
                        storage_retained: closed.storage_retained(),
                        primary,
                        history: Vec::new(),
                    }),
                    Err(owner) => Err(Box::new(ReuseFinalizationFailure {
                        owner: Owner::Classified(owner),
                        primary,
                        errors,
                        bookkeeping: None,
                    })),
                };
            }
            FailureOwner::AllocationUnconfirmed(retained) => {
                errors.push(primary.take().expect("actual allocation cleanup failure"));
                Owner::Native {
                    retained,
                    session: None,
                }
            }
            FailureOwner::Closed(owner) => Owner::Native {
                retained: owner.retained,
                session: None,
            },
            FailureOwner::Viewing(viewing) => Owner::Native {
                retained: viewing.owner.retained,
                session: Some(viewing.session),
            },
        };
        finish(owner, primary, errors, budget)
    }
}
fn finish<'a>(
    owner: Owner<'a>,
    primary: Option<Error>,
    errors: Vec<Error>,
    budget: CleanupBudget,
) -> Result<ReuseHandlerClosed, Box<ReuseFinalizationFailure<'a>>> {
    let mut cleanup = Finalizer {
        owner,
        primary,
        errors,
        completed: false,
        target: None,
    };
    cleanup.close_native(budget);
    cleanup.metadata(budget);
    let observation = cleanup.observe_storage();
    if cleanup.completed
        && cleanup.errors.is_empty()
        && observation.as_ref().is_some_and(|value| !value.is_live())
    {
        // Reuse starts with existing_running=true. The original finally only
        // removes its Office/laptop registration after a completion receipt;
        // a stopped observation alone cannot authorize that separate effect.
        // A fresh stop scope precedes lifecycle acquisition and remains held
        // through the original Office producer's checked close. A prior stop
        // refusal never grants this separate shared-registration effect.
        cleanup.close_registration(budget);
    }
    if !cleanup.completed
        && observation.as_ref().is_some_and(|value| !value.is_live())
        && cleanup.owner.scope().registration.is_some()
    {
        // The original finally retains this Office without a receipt. Its
        // still-listening owner can admit future requests, so idle-now cannot
        // authorize physical storage consumption. Preserve the Box and Hold
        // for explicit recovery instead of forgetting that producer.
        cleanup.errors.push(Error::Gate(GateError::Refused(
            "WORKER_REUSE_OFFICE_RETAINED",
        )));
    }
    let mut storage_retained = false;
    if cleanup.errors.is_empty()
        && let Some(observation) = observation
    {
        match cleanup.transfer_storage(&observation, budget.phase(20_000)) {
            Ok((next, retained)) => {
                cleanup = next;
                storage_retained = retained;
            }
            Err(next) => cleanup = *next,
        }
    }
    let bookkeeping = cleanup
        .errors
        .is_empty()
        .then_some((cleanup.completed, storage_retained));
    if let Err(error) = budget.close_request(&cleanup.owner.scope().preparing.admitted.request) {
        cleanup.errors.push(Error::Transport(error));
    }
    if cleanup.errors.is_empty()
        && let Some(token) = &mut cleanup.owner.scope_mut().active
        && let Err(error) = budget.release_hold(token)
    {
        cleanup.errors.push(Error::Transport(error));
    }
    if cleanup.errors.is_empty() {
        Ok(ReuseHandlerClosed {
            completed: cleanup.completed,
            storage_retained,
            primary: cleanup.primary,
            history: Vec::new(),
        })
    } else {
        Err(Box::new(ReuseFinalizationFailure {
            owner: cleanup.owner,
            primary: cleanup.primary,
            errors: cleanup.errors,
            bookkeeping,
        }))
    }
}
impl<'a> Finalizer<'a> {
    fn close_native(&mut self, budget: CleanupBudget) {
        let Owner::Native { retained, session } = &mut self.owner else {
            unreachable!("original native phase");
        };
        match retained.native.target() {
            Ok(target) => self.target = Some(target),
            Err(error) => self.errors.push(Error::Storage(error)),
        }
        match retained.native.completed() {
            Ok(completed) => {
                self.completed = completed;
                if completed
                    && let Err(error) = retained
                        .native
                        .stop_completed(retained.scope.preparing.broker())
                {
                    self.errors.push(Error::Storage(error));
                }
            }
            Err(error) => self.errors.push(Error::Storage(error)),
        }
        // After actual stop, native ownership first acquires its original
        // guard, then starts TERM/KILL. Bookkeeping cannot consume that grace.
        let closed = match budget {
            CleanupBudget::Bounded(end) => retained.native.close(end),
            CleanupBudget::Worker => retained.native.close_for_worker(),
        };
        if let Err(error) = closed {
            self.errors.push(Error::Storage(error));
        }
        // No live descriptor is extracted here; its actual owner remains in
        // the same Host record until checked reclaim succeeds.
        *session = None;
    }
    fn observe_storage(&mut self) -> Option<ExistingStorageObservation> {
        let Owner::Native { retained, .. } = &self.owner else {
            unreachable!("original native phase");
        };
        match retained.native.observe_final_storage() {
            Ok(observation) => Some(observation),
            Err(error) => {
                self.errors.push(Error::Storage(error));
                None
            }
        }
    }
    fn transfer_storage(
        self,
        observation: &ExistingStorageObservation,
        end: Instant,
    ) -> Result<(Self, bool), Box<Self>> {
        let Self {
            owner,
            primary,
            mut errors,
            completed,
            target,
        } = self;
        let Owner::Native {
            retained,
            session: _,
        } = owner
        else {
            unreachable!("original native phase");
        };
        let RetainedReuse { scope, native } = retained;
        let owner = match native.reclaim_final_storage(observation) {
            Ok(returned) => match returned.finish_storage(end) {
                Ok(retained) => {
                    return Ok((
                        Self {
                            owner: Owner::Transferred(scope),
                            primary,
                            errors,
                            completed,
                            target,
                        },
                        retained,
                    ));
                }
                Err(failure) => {
                    let (returned, error) = failure.into_parts();
                    errors.push(Error::Storage(error));
                    Owner::Restored(Box::new(RestoredReuse { scope, returned }))
                }
            },
            Err(failure) => {
                let (native, error) = failure.into_parts();
                errors.push(Error::Storage(error));
                Owner::Native {
                    retained: RetainedReuse { scope, native },
                    session: None,
                }
            }
        };
        Err(Box::new(Self {
            owner,
            primary,
            errors,
            completed,
            target,
        }))
    }
}
impl ReuseFinalizationFailure<'_> {
    pub fn primary_error(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.primary.as_ref().map(Error::as_error)
    }
    pub fn request(&self) -> &WorkerRequest {
        match &self.owner {
            Owner::Classified(owner) => owner.request(),
            owner => owner.scope().preparing.admitted.request(),
        }
    }
    pub fn cleanup_error_count(&self) -> usize {
        self.errors.len()
            + match &self.owner {
                Owner::Classified(owner) => owner.cleanup_error_count(),
                _ => 0,
            }
    }
}
impl std::fmt::Debug for ReuseFinalizationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("ReuseFinalizationFailure")
            .field("session", self.request().session())
            .field("primary", &self.primary)
            .field("errors", &self.errors)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for ReuseFinalizationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(primary) = &self.primary {
            write!(out, "{}; ", primary.as_error())?;
        }
        if let Owner::Classified(owner) = &self.owner {
            write!(out, "{owner}; ")?;
        }
        for error in &self.errors {
            match error {
                Error::Storage(error) => write!(out, "{error}; ")?,
                Error::Gate(error) => write!(out, "{error}; ")?,
                Error::Transport(error) => write!(out, "{error}; ")?,
            }
        }
        Ok(())
    }
}
impl std::error::Error for ReuseFinalizationFailure<'_> {}
impl Error {
    fn as_error(&self) -> &(dyn std::error::Error + 'static) {
        match self {
            Self::Storage(error) => error,
            Self::Gate(error) => error,
            Self::Transport(error) => error,
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.as_error().fmt(out)
    }
}
