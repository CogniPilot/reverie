//! Original ordinary cold launch. The same accepted socket, counted hold,
//! allocation and resource owners survive every partial or uncertain phase.
use super::*;
use crate::installing_broker::{recovered::RecoveredOffice, storage};
use reverie_contracts::worker_config::EffectiveWorkerConfig;
use reverie_host::{
    office::{OfficeConstruction, OfficeService},
    worker_laptop::{
        CreatedLaptop, NixReleasedPane, StartedContainer, StartedMemoryPolicy,
        StartedMemoryReadback,
    },
    worker_launch::ObservedCreatePlan,
    worker_nix::NixStoreGuard,
    worker_source_stop::StoppedLaptopRemoval,
};
mod error;
mod memory;
mod network;
mod nix;
mod start;
mod stop;
use error::ColdError;

struct ColdScope<'a> {
    preparing: PreparingWorkerLaunch<'a>,
    active: Option<ActiveLaunchToken<'a>>,
    observed: WaitObservation,
    current: Arc<ValidatedWorkerSnapshot>,
    resources: EffectiveWorkerConfig,
}
struct Direct {
    storage: StorageClaim,
    plan: ObservedCreatePlan,
    target: ExistingColdTarget,
}
struct Stopped {
    storage: StorageClaim,
    plan: ObservedCreatePlan,
    removal: Option<StoppedLaptopRemoval>,
}
struct PreparingNix {
    stopped: Stopped,
    guard: NixStoreGuard,
}
struct CopyingNix {
    preparation: storage::NixStoragePreparation,
    plan: ObservedCreatePlan,
    prepared: EffectiveWorkerConfig,
    removal: Option<StoppedLaptopRemoval>,
}
enum Resources {
    Direct(Direct),
    Replacement(storage::ReplacementStopPreparation),
    Legacy(storage::OrdinaryStopPreparation),
    Stopped(Stopped),
    PreparingNix(PreparingNix),
    CopyingNix(CopyingNix),
    Network(Arc<storage::NetworkStoragePreparation>),
}
struct ColdBody<'a> {
    scope: ColdScope<'a>,
    lifecycle: Option<LaptopLifecycle<'a>>,
    resources: Option<Resources>,
    office: Option<Arc<RecoveredOffice>>,
    construction: Option<(Arc<OfficeService>, OfficeConstruction)>,
    network_phone: Option<reverie_host::office::OfficePhone>,
    creation: Option<CreationContext>,
    memory: Option<MemoryJoin>,
}
struct CreationContext {
    created: CreatedLaptop,
    started: Option<StartedContainer>,
}
enum MemoryJoin {
    Policy(StartedMemoryPolicy),
    Readback(StartedMemoryReadback),
}
/// Stored in the existing lifecycle only after actual pane and guard success.
/// This shared owner is also retained by the original handler continuation.
pub(in crate::installing_broker) struct StartedLaptop {
    pub(in crate::installing_broker) network: Arc<storage::NetworkStoragePreparation>,
    pub(in crate::installing_broker) pane: NixReleasedPane,
    pub(in crate::installing_broker) office: Arc<RecoveredOffice>,
    pub(in crate::installing_broker) created: CreatedLaptop,
}
#[must_use = "retain the original handler and actual started resources through finalization"]
pub struct AllocationClosedCold<'a> {
    scope: ColdScope<'a>,
    started: Arc<StartedLaptop>,
}
#[must_use = "failure retains every actual phase, admission and counted handler owner"]
pub struct ColdLaunchFailure<'a> {
    owner: ColdBody<'a>,
    cause: ColdError,
}
impl<'a> ColdWorkerLaunch<'a> {
    pub fn prepare_cold(self) -> Result<AllocationClosedCold<'a>, Box<ColdLaunchFailure<'a>>> {
        let mut owner = ColdBody::from_classified(self);
        let result = owner
            .stop_existing()
            .and_then(|()| owner.copy_nix())
            .and_then(|()| owner.prepare_network())
            .and_then(|()| owner.start_body());
        match result {
            Ok(started) => owner.close_allocation(started),
            Err(cause) => {
                // The source's `with self.lock` unwinds before handler finally.
                // Keep all real owners, but never return a locked lifecycle.
                drop(owner.lifecycle.take());
                Err(Box::new(ColdLaunchFailure { owner, cause }))
            }
        }
    }
}
impl<'a> ColdBody<'a> {
    fn from_classified(classified: ColdWorkerLaunch<'a>) -> Self {
        let ColdWorkerLaunch {
            inspected,
            resources,
            target,
        } = classified;
        let InspectedWorkerLaunch {
            observed,
            previous: _,
        } = inspected;
        let observe::ObservedWorkerLaunch {
            claimed,
            current,
            plan,
        } = observed;
        let ClaimedWorkerLaunch {
            preparing,
            active,
            observed,
            mut storage,
            lifecycle,
        } = claimed;
        Self {
            scope: ColdScope {
                preparing,
                active,
                observed,
                current,
                resources,
            },
            lifecycle: Some(lifecycle),
            resources: Some(Resources::Direct(Direct {
                storage: storage.take().expect("actual classified storage"),
                plan,
                target,
            })),
            office: None,
            construction: None,
            network_phone: None,
            creation: None,
            memory: None,
        }
    }
    fn broker(&self) -> &'a InstallingBroker {
        self.scope.preparing.broker()
    }
    fn lifecycle(&self) -> &LaptopLifecycle<'a> {
        self.lifecycle.as_ref().expect("actual original lifecycle")
    }
    fn end(&self) -> Instant {
        let end = Instant::now() + std::time::Duration::from_secs(20);
        self.broker()
            .storage
            .runtime
            .stop_deadline()
            .map_or(end, |stop| end.min(stop))
    }
    fn close_allocation(
        mut self,
        started: Arc<StartedLaptop>,
    ) -> Result<AllocationClosedCold<'a>, Box<ColdLaunchFailure<'a>>> {
        drop(self.lifecycle.take());
        if let Some(admission) = self.scope.preparing.admitted.admission.take()
            && let Err(error) = admission.close()
        {
            return Err(Box::new(ColdLaunchFailure {
                owner: self,
                cause: error.into(),
            }));
        }
        Ok(AllocationClosedCold {
            scope: self.scope,
            started,
        })
    }
}
impl ColdLaunchFailure<'_> {
    pub fn cause(&self) -> &(dyn std::error::Error + 'static) {
        &self.cause
    }
}
impl std::fmt::Debug for ColdLaunchFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("ColdLaunchFailure")
            .field(&self.cause)
            .finish()
    }
}
impl std::fmt::Display for ColdLaunchFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for ColdLaunchFailure<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
