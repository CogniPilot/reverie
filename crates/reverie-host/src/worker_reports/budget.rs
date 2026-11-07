//! Fixed cleanup entrypoints select component ceiling or actual worker policy.
//! Worker cleanup has no invented pre-stop aggregate; every lock wait observes
//! the SAME live first-stop bound if stopping begins while it is waiting.
use super::*;
pub(super) struct CleanupBudget<'a> {
    engine: &'a InstalledWorkerEngine,
    ceiling: Option<Instant>,
}
impl<'a> CleanupBudget<'a> {
    pub(super) fn bounded(service: &'a WorkerReportService, end: Instant) -> Self {
        Self {
            engine: &service.engine,
            ceiling: Some(end),
        }
    }
    pub(super) fn worker(service: &'a WorkerReportService) -> Self {
        Self {
            engine: &service.engine,
            ceiling: None,
        }
    }
    pub(super) fn deadline(&self) -> Option<Instant> {
        match (self.ceiling, self.engine.stop_deadline()) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) | (None, Some(a)) => Some(a),
            (None, None) => None,
        }
    }
    pub(super) fn pause(&self) -> Result<()> {
        let pause = match self.deadline() {
            Some(end) => {
                let remaining = end.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(WorkerReportError::Unconfirmed);
                }
                remaining.min(Duration::from_millis(1))
            }
            None => Duration::from_millis(1),
        };
        std::thread::sleep(pause);
        Ok(())
    }
}
