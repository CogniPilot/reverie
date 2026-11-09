use super::*;
use crate::reservation_observer::StoppedRamPresence;
use reverie_contracts::reservation_engine::{InventoryDigest, StoppedRamDeclaration};
/// Captured read-side facts. No live PID/cgroup binding or resource credit.
#[derive(Clone, Debug)]
pub enum StoppedRamReport {
    Absent {
        current: CurrentEmployee,
        start_allowed: bool,
        effective_policy: String,
    },
    PresentStopped {
        current: CurrentEmployee,
        start_allowed: bool,
        declaration: StoppedRamDeclaration,
        metadata_digest: InventoryDigest,
        state_bytes: Vec<u8>,
        effective_policy: String,
    },
}
pub(super) fn capture(frame: &Frame<'_>) -> StoppedRamReport {
    let observed = frame
        .observed
        .as_ref()
        .expect("actual completed read-side observation");
    let current = frame.selection.current.clone();
    let start_allowed = frame.selection.start_allowed;
    let effective_policy =
        reverie_contracts::worker_config::policy_digest(observed.effective()).to_hex();
    match observed.presence() {
        StoppedRamPresence::Absent => StoppedRamReport::Absent {
            current,
            start_allowed,
            effective_policy,
        },
        StoppedRamPresence::PresentStopped(actual) => StoppedRamReport::PresentStopped {
            current,
            start_allowed,
            declaration: actual.declaration().clone(),
            metadata_digest: actual.metadata_digest().clone(),
            state_bytes: actual.state_bytes().to_vec(),
            effective_policy,
        },
    }
}
