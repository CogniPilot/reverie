//! OS-owner nomination import only. The real loaded snapshot chooses the
//! source and Runtime; this is not owner consent or a fleet-effect route.
use crate::worker_validation::ValidatedWorkerSnapshot;
use reverie_host::{
    worker_pool::{PoolNominationFailure, PoolNominationPublished},
    worker_runtime::WorkerRuntime,
};
use std::{path::Path, time::Instant};

pub fn nominate_os_worker_pool(
    snapshot: &ValidatedWorkerSnapshot,
    runtime: WorkerRuntime,
    request: &Path,
    end: Instant,
) -> Result<PoolNominationPublished, Box<PoolNominationFailure>> {
    reverie_host::worker_pool::publish_os_pool_nomination(
        snapshot.source_path(),
        snapshot.configuration(),
        request,
        runtime,
        end,
    )
}
/// Owner-facing derivation accepts only explicit enrollment response DATA.
/// Proposed fallback thresholds still require actual Q maintenance consent.
pub fn nominate_current_os_worker_pool(
    snapshot: &ValidatedWorkerSnapshot,
    runtime: WorkerRuntime,
    enrollment: &Path,
    end: Instant,
) -> Result<PoolNominationPublished, Box<PoolNominationFailure>> {
    reverie_host::worker_pool::publish_current_os_pool_nomination(
        snapshot.source_path(),
        snapshot.configuration(),
        enrollment,
        runtime,
        end,
    )
}
