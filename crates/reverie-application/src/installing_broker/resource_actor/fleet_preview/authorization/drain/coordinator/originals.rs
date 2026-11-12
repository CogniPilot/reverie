//! Complete unfinished steps of the ONE original interruption, then join.
//! No settlement is attempted before its actual original admission is known.
use super::*;
use reverie_host::worker_reports::{WorkerHandlersProgress, WorkerOriginalInterruptionProgress};

pub(super) fn advance_and_settle<'a>(
    authorization: &mut AuthenticatedPoolMigration<'a>,
    fence: &PoolTransitionFence,
    handlers: &mut WorkerOriginalHandlersDrain,
    broker: &Arc<InstallingBroker>,
    end: Instant,
) -> std::result::Result<(), MigrationCause<'a>> {
    loop {
        if authorization
            .advance_original_handlers(fence, handlers)
            .map_err(MigrationCause::Authorization)?
            == WorkerOriginalInterruptionProgress::Issued
        {
            break;
        }
        wait(handlers, broker, end)?;
    }
    loop {
        if authorization
            .settle_original_handlers(fence, handlers)
            .map_err(MigrationCause::Authorization)?
            == WorkerHandlersProgress::Settled
        {
            return Ok(());
        }
        wait(handlers, broker, end)?;
    }
}
fn wait<'a>(
    handlers: &WorkerOriginalHandlersDrain,
    broker: &Arc<InstallingBroker>,
    end: Instant,
) -> std::result::Result<(), MigrationCause<'a>> {
    let end = end.min(
        handlers
            .deadline(&broker.storage.runtime)
            .map_err(|cause| MigrationCause::Native(Cause::OriginalHandlers(Rc::new(cause))))?,
    );
    if Instant::now() >= end {
        return Err(MigrationCause::Refused(
            "POOL_MIGRATION_HANDLER_SETTLEMENT_EXPIRED",
        ));
    }
    std::thread::sleep(
        end.saturating_duration_since(Instant::now())
            .min(Duration::from_millis(10)),
    );
    Ok(())
}
