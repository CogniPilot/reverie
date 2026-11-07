//! A direct cleanup observation retains the actual Box and original plan.
//! It has no native inventory of its own: the application keeps this owner in
//! the SAME registry entry. Observation DATA never authorizes physical release.
use super::*;
use crate::{captured_client::CapturedCall, worker_storage::LaunchStorage};
mod error;
pub use error::DirectStorageRetainFailure;

struct Resources {
    storage: Box<LaunchStorage>,
    plan: ObservedCreatePlan,
    pending: Option<CapturedCall>,
    observation: Observation,
}
enum Observation {
    Unattempted,
    Reading,
    Known { current: Arc<()>, live: bool },
    Failed(Arc<LaptopError>),
}
enum State {
    Held(Box<Resources>),
    Consumed,
}
#[must_use = "retain this exact resource and any unresolved captured call"]
pub struct DirectStorageFinalizer {
    state: State,
}
pub struct DirectStorageObservation {
    owner: Arc<()>,
    current: Arc<()>,
    live: bool,
}
impl DirectStorageObservation {
    pub fn is_live(&self) -> bool {
        self.live
    }
}
impl WorkerRuntime {
    /// Transfer the actual original resources, not a target/path/CID selected
    /// by a request. Pure constructor refusal returns both original owners.
    pub fn retain_direct_final_storage(
        &self,
        storage: Box<LaunchStorage>,
        plan: ObservedCreatePlan,
    ) -> std::result::Result<DirectStorageFinalizer, Box<DirectStorageRetainFailure>> {
        if let Err(error) = plan.assert_storage_owner(self, &storage) {
            return Err(Box::new(DirectStorageRetainFailure {
                storage,
                plan,
                cause: LaptopError::Plan(error),
            }));
        }
        Ok(DirectStorageFinalizer {
            state: State::Held(Box::new(Resources {
                storage,
                plan,
                pending: None,
                observation: Observation::Unattempted,
            })),
        })
    }
}
impl DirectStorageFinalizer {
    /// One fresh named read. A missing original CID is never absence evidence;
    /// the fixed shared reader still requires inspect or a complete census.
    pub fn observe(&mut self, runtime: &WorkerRuntime) -> Result<DirectStorageObservation> {
        let State::Held(held) = &mut self.state else {
            return Err(LaptopError::Refused("WORKER_DIRECT_STORAGE_CONSUMED"));
        };
        held.plan
            .assert_storage_owner(runtime, &held.storage)
            .map_err(LaptopError::Plan)?;
        need(
            matches!(held.observation, Observation::Unattempted),
            "WORKER_DIRECT_STORAGE_ALREADY_OBSERVED",
        )?;
        held.observation = Observation::Reading;
        let result = super::final_storage::observe(
            runtime,
            &mut held.pending,
            &held.storage,
            &held.plan,
            None,
        );
        match result {
            Ok(live) => {
                let current = Arc::new(());
                held.observation = Observation::Known {
                    current: current.clone(),
                    live,
                };
                Ok(DirectStorageObservation {
                    owner: held.storage.owner_identity().clone(),
                    current,
                    live,
                })
            }
            Err(error) => {
                let error = Arc::new(error);
                held.observation = Observation::Failed(error.clone());
                Err(LaptopError::Recorded(error))
            }
        }
    }
    /// Resource handoff only. The application must keep its exact registry
    /// transaction and prove all Office/native writers before physical close.
    pub fn reclaim(
        &mut self,
        runtime: &WorkerRuntime,
        observation: &DirectStorageObservation,
    ) -> Result<(Box<LaunchStorage>, ObservedCreatePlan, bool)> {
        self.require_observation(runtime, observation)?;
        let State::Held(held) = std::mem::replace(&mut self.state, State::Consumed) else {
            unreachable!("checked same held direct resources");
        };
        Ok((held.storage, held.plan, observation.live))
    }
    fn require_observation(
        &self,
        runtime: &WorkerRuntime,
        observation: &DirectStorageObservation,
    ) -> Result<()> {
        let State::Held(held) = &self.state else {
            return Err(LaptopError::Refused("WORKER_DIRECT_STORAGE_CONSUMED"));
        };
        held.plan
            .assert_storage_owner(runtime, &held.storage)
            .map_err(LaptopError::Plan)?;
        if let Observation::Failed(cause) = &held.observation {
            return Err(LaptopError::Recorded(cause.clone()));
        }
        need(
            held.pending.is_none()
                && matches!(&held.observation, Observation::Known {current, live}
                    if Arc::ptr_eq(current, &observation.current) && *live == observation.live)
                && Arc::ptr_eq(held.storage.owner_identity(), &observation.owner),
            "WORKER_DIRECT_STORAGE_OBSERVATION_CHANGED",
        )
    }
}
impl Drop for DirectStorageFinalizer {
    fn drop(&mut self) {
        if let State::Held(held) = std::mem::replace(&mut self.state, State::Consumed) {
            // Includes the SAME Box/plan, any pending ticket and sticky cause.
            // Abandonment cannot close a lease or acknowledge native cleanup.
            std::mem::forget(held);
        }
    }
}
