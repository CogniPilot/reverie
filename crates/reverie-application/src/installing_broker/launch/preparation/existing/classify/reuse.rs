//! Whole actual reuse continuation. Native closure/restoration alone is never
//! completed-command stop, handler finalization, or storage release credit.
use super::*;
use crate::installing_broker::storage::{
    ExistingStorageError, ExistingStoragePreparation, ExistingStorageReturned,
};
use reverie_host::worker_laptop::{ExistingViewerStart, LaptopError, ViewerSession};

struct ReuseScope<'a> {
    preparing: PreparingWorkerLaunch<'a>,
    observed: WaitObservation,
    active: Option<ActiveLaunchToken<'a>>,
    current: Arc<ValidatedWorkerSnapshot>,
    resources: EffectiveWorkerConfig,
}
struct RetainedReuse<'a> {
    scope: ReuseScope<'a>,
    native: ExistingStoragePreparation,
}
#[must_use = "the original lifecycle and allocation scope are still held"]
pub struct PreparedReuseViewer<'a> {
    retained: RetainedReuse<'a>,
    lifecycle: LaptopLifecycle<'a>,
}
#[must_use = "retain the original J and counted hold through native cleanup"]
pub struct AllocationClosedReuse<'a> {
    retained: RetainedReuse<'a>,
}
#[must_use = "a completed receipt requires stop BEFORE viewer cleanup"]
pub struct ViewingReuse<'a> {
    owner: AllocationClosedReuse<'a>,
    session: ViewerSession,
}
#[must_use = "same-Box restoration is not handler or storage release"]
pub struct RestoredReuse<'a> {
    scope: ReuseScope<'a>,
    returned: ExistingStorageReturned,
}
enum FailureOwner<'a> {
    Classified(Box<ReusableWorkerLaunch<'a>>),
    AllocationUnconfirmed(RetainedReuse<'a>),
    Closed(AllocationClosedReuse<'a>),
    Viewing(ViewingReuse<'a>),
}
#[derive(Debug)]
enum Cause {
    Storage(ExistingStorageError),
    Gate(GateError),
    Refused(&'static str),
}
#[must_use = "failure retains the same actual resource and handler owners"]
pub struct ReuseViewerFailure<'a> {
    owner: FailureOwner<'a>,
    cause: Cause,
}
impl<'a> ReusableWorkerLaunch<'a> {
    /// Move the real classified resource to the same bounded Host inventory
    /// while the original lifecycle is held. No native constructor runs here.
    pub fn prepare_viewer(self) -> Result<PreparedReuseViewer<'a>, Box<ReuseViewerFailure<'a>>> {
        let Self {
            receipt,
            inspected,
            resources,
        } = self;
        let InspectedWorkerLaunch { observed, previous } = inspected;
        let observe::ObservedWorkerLaunch {
            mut claimed,
            current,
            plan,
        } = observed;
        let connection = claimed.preparing.admitted.request.connection.clone();
        let storage = claimed.storage.take().expect("genuine classified storage");
        let previous = previous.expect("genuine classified running observation");
        let receipt = receipt.expect("genuine classified runtime receipt");
        match storage.retain_existing_relay_for_connection(plan, previous, receipt, &connection) {
            Ok(native) => {
                let ClaimedWorkerLaunch {
                    preparing,
                    observed,
                    active,
                    lifecycle,
                    storage: _,
                } = claimed;
                Ok(PreparedReuseViewer {
                    retained: RetainedReuse {
                        scope: ReuseScope {
                            preparing,
                            observed,
                            active,
                            current,
                            resources,
                        },
                        native,
                    },
                    lifecycle,
                })
            }
            Err(failure) => {
                let (storage, plan, _request, previous, receipt, cause) = failure.into_parts();
                claimed.storage = Some(storage);
                let original = Self {
                    receipt: Some(receipt),
                    inspected: InspectedWorkerLaunch {
                        observed: observe::ObservedWorkerLaunch {
                            claimed,
                            current,
                            plan,
                        },
                        previous: Some(previous),
                    },
                    resources,
                };
                Err(Box::new(ReuseViewerFailure {
                    owner: FailureOwner::Classified(Box::new(original)),
                    cause: Cause::Storage(cause),
                }))
            }
        }
    }
}
impl<'a> PreparedReuseViewer<'a> {
    /// Original order: leave the actual lifecycle, then close the actual
    /// allocation admission. No protected canonical-release receipt is forged.
    pub fn close_allocation(
        self,
    ) -> Result<AllocationClosedReuse<'a>, Box<ReuseViewerFailure<'a>>> {
        let Self {
            mut retained,
            lifecycle,
        } = self;
        drop(lifecycle);
        if let Some(admission) = retained.scope.preparing.admitted.admission.take()
            && let Err(cause) = admission.close()
        {
            return Err(Box::new(ReuseViewerFailure {
                owner: FailureOwner::AllocationUnconfirmed(retained),
                cause: Cause::Gate(cause),
            }));
        }
        Ok(AllocationClosedReuse { retained })
    }
}
impl<'a> AllocationClosedReuse<'a> {
    /// Close an unstarted/known native component while retaining the complete
    /// handler and restored claim. This performs no laptop stop or release.
    pub fn close_native_component(
        self,
        end: Instant,
    ) -> Result<RestoredReuse<'a>, Box<ReuseViewerFailure<'a>>> {
        if let Err(cause) = self.retained.native.close(end) {
            return Err(Box::new(ReuseViewerFailure {
                owner: FailureOwner::Closed(self),
                cause: Cause::Storage(cause),
            }));
        }
        self.restore_component()
    }
    fn restore_component(self) -> Result<RestoredReuse<'a>, Box<ReuseViewerFailure<'a>>> {
        let RetainedReuse { scope, native } = self.retained;
        match native.reclaim() {
            Ok(returned) => Ok(RestoredReuse { scope, returned }),
            Err(failure) => {
                let (native, cause) = (*failure).into_parts();
                Err(Box::new(ReuseViewerFailure {
                    owner: FailureOwner::Closed(AllocationClosedReuse {
                        retained: RetainedReuse { scope, native },
                    }),
                    cause: Cause::Storage(cause),
                }))
            }
        }
    }
    /// Only a confirmed allocation close reaches this constructor. Any native
    /// uncertainty retains the same inventory record and original J/Hold.
    pub fn start(self, end: Instant) -> Result<ViewingReuse<'a>, Box<ReuseViewerFailure<'a>>> {
        let cause = match self.retained.native.start(
            &self.retained.scope.preparing.admitted.request.connection,
            end,
        ) {
            Ok(ExistingViewerStart::Started(session)) => {
                return Ok(ViewingReuse {
                    owner: self,
                    session,
                });
            }
            Ok(ExistingViewerStart::Retained) => match self.retained.native.failure() {
                Ok(Some(cause)) => {
                    Cause::Storage(ExistingStorageError::Host(LaptopError::Recorded(cause)))
                }
                Ok(None) => Cause::Refused("WORKER_REUSE_VIEWER_RETAINED"),
                Err(cause) => Cause::Storage(ExistingStorageError::Host(cause)),
            },
            Err(error) => Cause::Storage(error),
        };
        Err(Box::new(ReuseViewerFailure {
            owner: FailureOwner::Closed(self),
            cause,
        }))
    }
}
impl<'a> ViewingReuse<'a> {
    pub(in crate::installing_broker::launch) fn broker(&self) -> &InstallingBroker {
        self.owner.retained.scope.preparing.broker()
    }
    pub(in crate::installing_broker::launch) fn relay_connection(
        &self,
    ) -> &Arc<reverie_host::worker_reports::WorkerLaunchConnection> {
        &self
            .owner
            .retained
            .scope
            .preparing
            .admitted
            .request
            .connection
    }
    pub(in crate::installing_broker::launch) fn viewer_session(&self) -> &ViewerSession {
        &self.session
    }
    pub fn request(&self) -> &WorkerRequest {
        self.owner.retained.scope.preparing.admitted.request()
    }
    /// Native component cleanup only, not the integrated handler finalizer.
    /// The original finalizer must FIRST re-stat the bound receipt on EVERY
    /// exit path and stop completed owned laptops before invoking cleanup.
    /// The returned owner still retains J/Hold/active/storage; no handler or
    /// laptop/storage release is performed here.
    pub fn close_native_component(
        self,
        end: Instant,
    ) -> Result<RestoredReuse<'a>, Box<ReuseViewerFailure<'a>>> {
        if let Err(error) = self.owner.retained.native.close(end) {
            return Err(Box::new(ReuseViewerFailure {
                owner: FailureOwner::Viewing(self),
                cause: Cause::Storage(error),
            }));
        }
        let Self { owner, session } = self;
        drop(session);
        owner.restore_component()
    }
}
impl RestoredReuse<'_> {
    pub fn native_failure(&self) -> Option<&LaptopError> {
        self.returned.failure()
    }
    pub fn request(&self) -> &WorkerRequest {
        self.scope.preparing.admitted.request()
    }
    /// The actual Direct claim remains owned. EOF never proves the running
    /// laptop absent or authorizes logical Hold/storage/handler release.
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.scope.resources
    }
}
impl std::fmt::Debug for ReuseViewerFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReuseViewerFailure")
            .field("cause", &self.cause)
            .field("request_session", self.request().session())
            .finish_non_exhaustive()
    }
}
impl ReuseViewerFailure<'_> {
    /// A constructor can finish after its original waiter. Read its SAME
    /// retained record without resetting the original primary outcome.
    pub fn native_failure(&self) -> Result<Option<Arc<LaptopError>>, LaptopError> {
        match &self.owner {
            FailureOwner::Classified(_) => Ok(None),
            FailureOwner::AllocationUnconfirmed(owner) => owner.native.failure(),
            FailureOwner::Closed(owner) => owner.retained.native.failure(),
            FailureOwner::Viewing(owner) => owner.owner.retained.native.failure(),
        }
    }
    pub fn request(&self) -> &WorkerRequest {
        match &self.owner {
            FailureOwner::Classified(owner) => owner.request(),
            FailureOwner::AllocationUnconfirmed(owner) => owner.scope.preparing.admitted.request(),
            FailureOwner::Closed(owner) => owner.retained.scope.preparing.admitted.request(),
            FailureOwner::Viewing(owner) => owner.request(),
        }
    }
}
impl std::fmt::Debug for ReuseScope<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RetainedReuseScope")
            .field("waited", &self.observed.waited())
            .field("active_reference", &self.active.is_some())
            .field("configuration_source", &self.current.source_path())
            .finish_non_exhaustive()
    }
}
impl std::fmt::Debug for RestoredReuse<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RestoredReuse")
            .field("scope", &self.scope)
            .field("native", &self.returned)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for ReuseViewerFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.cause {
            Cause::Storage(e) => e.fmt(f),
            Cause::Gate(e) => e.fmt(f),
            Cause::Refused(e) => f.write_str(e),
        }
    }
}
impl std::error::Error for ReuseViewerFailure<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match &self.cause {
            Cause::Storage(e) => Some(e),
            Cause::Gate(e) => Some(e),
            Cause::Refused(_) => None,
        }
    }
}
#[cfg(test)]
mod tests;
