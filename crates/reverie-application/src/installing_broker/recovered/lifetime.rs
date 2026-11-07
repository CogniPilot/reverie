//! Last-service retention only. No Drop result acknowledges process settlement,
//! stopped laptops, global unlock, durable recovery, or released capacity.
use super::*;
use reverie_host::{command_telemetry::CommandTelemetry, worker_reports::WorkerReportService};
use std::sync::OnceLock;

// Retain the actual jointly owned services rather than rebuilding a registry
// from names, path data or an Office close result. There is no strong-reference
// cycle during ordinary operation; only an unresolved last-service Drop enters
// this process-lifetime quarantine. Structured shutdown remains a real consumer
// obligation and must account for every native constructor/process owner.
type Abandoned = (
    Arc<InstalledWorker>,
    Arc<storage::StorageRegistry>,
    Arc<RecoveryOwners>,
    Arc<CommandTelemetry>,
    Arc<WorkerReportService>,
);
fn abandoned() -> &'static Mutex<Vec<Abandoned>> {
    static OWNERS: OnceLock<Mutex<Vec<Abandoned>>> = OnceLock::new();
    OWNERS.get_or_init(|| Mutex::new(Vec::new()))
}
impl RecoveryOwners {
    fn known_empty(&self, installed: &InstalledWorker) -> bool {
        self.office.try_lock().is_ok_and(|office| office.is_none())
            && self
                .uncertain
                .try_lock()
                .is_ok_and(|claims| claims.is_empty())
            && installed.laptops.try_lock().is_ok_and(|laptops| {
                laptops.transients_empty()
                    && laptops.iter().all(|entry| match &entry.owner {
                        LaptopOwner::Recovered(_) => false,
                        #[cfg(test)]
                        LaptopOwner::Modeled => true,
                    })
            })
    }
}
impl Drop for InstallingBroker {
    fn drop(&mut self) {
        // Poison/contention cannot establish absence. A captured Office also
        // remains unresolved here until a real structured shutdown consumes it;
        // closing one phone never supplies Company/global settlement.
        if self.recovery.known_empty(&self.installed) && self.storage.known_empty_for_service_drop()
        {
            return;
        }
        abandoned()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push((
                self.installed.clone(),
                self.storage.clone(),
                self.recovery.clone(),
                self.telemetry.clone(),
                self.reports.clone(),
            ));
    }
}

#[cfg(test)]
pub(super) fn take_abandoned(installed: &Arc<InstalledWorker>) -> Abandoned {
    let mut owners = abandoned().lock().unwrap();
    let at = owners
        .iter()
        .position(|entry| Arc::ptr_eq(&entry.0, installed))
        .expect("the real dropped broker was retained");
    owners.remove(at)
}
