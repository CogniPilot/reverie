//! Original service-thread custody; no second registry or worker thread.
use super::*;
impl BrokerService {
    pub(super) fn poll_supervisor(&self) -> Result<(), BrokerServiceError> {
        let mut retained = self
            .supervisor
            .try_borrow_mut()
            .map_err(|_| BrokerServiceError::Supervisor("WORKER_SUPERVISOR_OWNER_BUSY".into()))?;
        if let Some(owner) = retained.as_ref() {
            return Err(BrokerServiceError::Supervisor(owner.to_string()));
        }
        match self.startup.owner.broker.supervise_detached() {
            Ok(()) => Ok(()),
            Err(owner) => {
                let diagnostic = owner.to_string();
                *retained = Some(owner);
                Err(BrokerServiceError::Supervisor(diagnostic))
            }
        }
    }
    pub(super) fn supervisor_closed(&self) -> bool {
        self.supervisor
            .try_borrow()
            .is_ok_and(|owner| owner.is_none())
    }
}
impl BrokerServiceFailure {
    /// Settle only already-issued work in this SAME detached stop. It never
    /// repeats a stop, clears its pending SID or releases admission/storage.
    pub fn settle_detached_native(&mut self) -> Result<(), StorageWorkflowError> {
        self.service
            .supervisor
            .try_borrow_mut()
            .map_err(|_| StorageWorkflowError::refused("WORKER_SUPERVISOR_OWNER_BUSY"))?
            .as_mut()
            .map_or(Ok(()), |owner| owner.settle_native())
    }
}
