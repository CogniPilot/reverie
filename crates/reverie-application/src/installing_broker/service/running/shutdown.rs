//! SIGTERM/service finally does not secretly issue C stop-laptops. Actual
//! runtime resources must independently close; unresolved owners stay retained.
use super::*;
impl BrokerService {
    pub(super) fn shutdown(
        &mut self,
        errors: &mut Vec<BrokerServiceError>,
    ) -> Result<BrokerServiceClosed, ()> {
        let broker = &self.startup.owner.broker;
        let end = broker.storage.runtime.request_stop();
        let signal = self
            .startup
            .owner
            .signals
            .as_ref()
            .and_then(BrokerSignals::termination_signal);
        if let Err(error) = self.listener.close() {
            errors.push(BrokerServiceError::Listener(error));
        }
        // Interrupt real accepted sockets before asking original handler stacks
        // to reconcile. A thread/data response cannot satisfy Record settlement.
        if let Err(error) = broker.reports.interrupt_worker_handlers(end) {
            errors.push(BrokerServiceError::Handler(error));
        }
        if let Err(error) = broker.reports.reconcile_worker_handlers(end) {
            errors.push(BrokerServiceError::Handler(error));
        }
        if let Err(error) = broker.reports.close(end) {
            errors.push(BrokerServiceError::Handler(error));
        }
        if let Err(error) = broker.close_command_telemetry(end) {
            errors.push(BrokerServiceError::Telemetry(error));
        }
        if let Err(error) = broker.close_chat_images(end) {
            errors.push(BrokerServiceError::Images(error));
        }
        if let Err(error) = broker.recovery.close_service_owners(broker, end) {
            errors.push(BrokerServiceError::Recovery(error));
        }
        let runtime_closed = match broker.storage.runtime.close(end) {
            Ok(()) => true,
            Err(error) => {
                errors.push(BrokerServiceError::Runtime(error));
                false
            }
        };
        if runtime_closed
            && let Some(signals) = &mut self.startup.owner.signals
            && let Err(error) = signals.finish_after_runtime_close()
        {
            errors.push(BrokerServiceError::Signal(error));
        }
        if errors.is_empty() {
            Ok(BrokerServiceClosed {
                termination_signal: signal,
            })
        } else {
            Err(())
        }
    }
}
