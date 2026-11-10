//! Shared ordinary-owner bootstrap for offline configuration operations.
use super::*;
use std::path::Path;

pub(super) fn capture(
    config: &Path,
) -> Result<&'static InstallingBroker, Box<dyn std::error::Error>> {
    let snapshot = load_owner_config(config)?;
    let runtime = WorkerRuntime::new(super::captured_engine()?, snapshot.envelope().base());
    let broker = InstallingBroker::new(snapshot, runtime)?;
    // Borrowed failure owners retain their original installing instance at a
    // stable address until process exit. Component closure remains explicit.
    Ok(Box::leak(Box::new(broker)))
}
