//! Shared ordinary-owner bootstrap for offline configuration operations.
use super::*;
use std::path::Path;

#[derive(Debug)]
struct FinalizedFailure {
    primary: Box<dyn std::error::Error>,
    cleanup: Option<Box<dyn std::error::Error>>,
}
impl std::fmt::Display for FinalizedFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.primary.fmt(out)?;
        if let Some(cleanup) = &self.cleanup {
            write!(out, "; cleanup: {cleanup}")?;
        }
        Ok(())
    }
}
impl std::error::Error for FinalizedFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.primary.as_ref())
    }
}
pub(super) fn finalized(
    primary: Box<dyn std::error::Error>,
    cleanup: Option<Box<dyn std::error::Error>>,
) -> Box<dyn std::error::Error> {
    Box::new(FinalizedFailure { primary, cleanup })
}

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
