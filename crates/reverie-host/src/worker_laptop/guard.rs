//! Consume only the original session Nix guard after the actual pane phase.
//! Storage remains in the SAME record, including after uncertain FD close.
use super::call_budget::CallBudget;
use super::*;
use crate::{
    worker_nix::{NixDisposition, NixError, NixStoreGuard},
    worker_storage::LaunchStorage,
};
use std::path::{Path, PathBuf};

pub(super) enum NixOwnership {
    Held(Box<NixReturned>),
    GuardConsumed(Box<GuardConsumed>),
}
pub(super) struct GuardConsumed {
    storage: LaunchStorage,
    outcome: std::result::Result<NixDisposition, NixError>,
    prepared: Option<PathBuf>,
    close: CloseState,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum CloseState {
    Closing,
    Confirmed,
    Unconfirmed,
}
impl NixOwnership {
    pub(super) fn held(&self) -> Result<&NixReturned> {
        match self {
            Self::Held(nix) => Ok(nix),
            Self::GuardConsumed(_) => Err(LaptopError::Refused("WORKER_LAPTOP_NIX_GUARD_CONSUMED")),
        }
    }
    pub(super) fn storage(&self) -> &LaunchStorage {
        match self {
            Self::Held(nix) => nix.laptop_storage(),
            Self::GuardConsumed(data) => &data.storage,
        }
    }
    pub(super) fn prepared_path(&self) -> Option<&Path> {
        match self {
            Self::Held(nix) => nix.prepared_path(),
            Self::GuardConsumed(data) if matches!(data.outcome, Ok(NixDisposition::Prepared)) => {
                data.prepared.as_deref()
            }
            Self::GuardConsumed(_) => None,
        }
    }
    fn finish_close(&mut self, result: std::result::Result<(), NixError>) -> Result<()> {
        let Self::GuardConsumed(data) = self else {
            unreachable!("actual remainder retained before guard close")
        };
        match result {
            Ok(()) => {
                data.close = CloseState::Confirmed;
                need(data.outcome.is_ok(), "WORKER_LAPTOP_NIX_OUTCOME_CHANGED")
            }
            Err(error) => {
                data.close = CloseState::Unconfirmed;
                Err(LaptopError::Nix(error))
            }
        }
    }
    fn unconfirmed(&self) -> bool {
        matches!(self,Self::GuardConsumed(data) if data.close!=CloseState::Confirmed)
    }
}
/// The original Nix guard's local descriptor finalizers succeeded. This is not
/// a global-flock-free claim: unrelated constructors or resource owners are not
/// settled by this operation. Storage and actual laptop custody remain retained.
#[must_use = "retain until actual admission/canonical release and checked cleanup"]
pub struct NixReleasedPane {
    pub(super) workflow: LaptopWorkflow,
}
impl NixReleasedPane {
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(other)
    }
}
#[must_use = "a refused close never grants viewer/admission/resource release"]
pub enum NixGuardRelease {
    Released(NixReleasedPane),
    Retained,
}
impl Workflows {
    fn release_guard(
        &self,
        runtime: &WorkerRuntime,
        pane: &StartedPane,
        deadline: CallBudget,
    ) -> Result<NixGuardRelease> {
        self.bound(runtime, &pane.workflow)?;
        let mut record = pane
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::Known
                && record.pending.is_none()
                && !record.unknown
                && record.outcome.as_ref().is_some_and(|result| result.is_ok())
                && record.resources().held_nix().is_ok()
                && record
                    .creation
                    .as_ref()
                    .is_some_and(|state| state.stage == create::CreateStage::PaneStarted),
            "WORKER_LAPTOP_NIX_GUARD_PHASE",
        )?;
        record.creation.as_mut().expect("actual pane").stage =
            create::CreateStage::ReleasingNixGuard;
        record.phase = Phase::Running;
        let result = run(runtime, &mut record, deadline);
        record.unknown |= record.resources().nix.unconfirmed();
        let succeeded = result.is_ok();
        record.outcome = Some(result.map_err(Arc::new));
        if !succeeded || record.unknown {
            record.phase = Phase::Retained;
            return Ok(NixGuardRelease::Retained);
        }
        record
            .creation
            .as_mut()
            .expect("actual consumed guard")
            .stage = create::CreateStage::NixGuardReleased;
        record.phase = Phase::Known;
        Ok(NixGuardRelease::Released(NixReleasedPane {
            workflow: pane.workflow.clone(),
        }))
    }
}
fn run(runtime: &WorkerRuntime, record: &mut Record, budget: CallBudget) -> Result<()> {
    guard_budget(runtime, budget)?;
    // Guard finalization is cleanup, not a new launch: cancellation does not
    // invent a fresh grace or prevent cleanup inside the original stop budget.
    let guard = consume(record);
    let result = guard.close();
    record
        .resources
        .as_mut()
        .expect("retained storage")
        .nix
        .finish_close(result)?;
    guard_budget(runtime, budget)
}
fn guard_budget(runtime: &WorkerRuntime, budget: CallBudget) -> Result<()> {
    budget
        .check(runtime)
        .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_NIX_GUARD_DEADLINE"))
}
fn consume(record: &mut Record) -> NixStoreGuard {
    // This is an infallible move under the same mutex, with no external call,
    // before guard.close can observe/refuse/consume either descriptor. No
    // guard-consumed variant can ever be returned as a NixReturned owner.
    let Resources {
        nix,
        plan,
        request,
        office,
        connection,
    } = record.resources.take().expect("actual resource record");
    let NixOwnership::Held(nix) = nix else {
        unreachable!("Held checked under same mutex")
    };
    let (guard, storage, outcome, prepared) = nix.split_for_laptop_guard_close();
    record.resources = Some(Resources {
        nix: NixOwnership::GuardConsumed(Box::new(GuardConsumed {
            storage,
            outcome,
            prepared,
            close: CloseState::Closing,
        })),
        plan,
        request,
        office,
        connection,
    });
    guard
}
impl WorkerRuntime {
    /// Canonical App must first publish the actual protected CLI-start record
    /// when applicable. Admission/canonical-release and viewer startup remain
    /// later actual App transitions; no callback or serialized proof is used.
    pub fn release_laptop_nix_guard(
        &self,
        pane: &StartedPane,
        deadline: Instant,
    ) -> Result<NixGuardRelease> {
        self.laptop_workflows()
            .release_guard(self, pane, CallBudget::bounded(deadline))
    }
    /// Actual ordinary cleanup keeps the original connection identity even
    /// after socket closure; it observes only the SAME live first-stop ceiling.
    pub fn release_laptop_nix_guard_for_connection(
        &self,
        pane: &StartedPane,
        connection: &crate::worker_reports::WorkerLaunchConnection,
    ) -> Result<NixGuardRelease> {
        self.laptop_workflows().assert_worker_cleanup_connection(
            self,
            &pane.workflow,
            connection,
        )?;
        self.laptop_workflows()
            .release_guard(self, pane, CallBudget::worker())
    }
}
