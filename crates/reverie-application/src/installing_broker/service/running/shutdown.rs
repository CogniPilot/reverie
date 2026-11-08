//! SIGTERM/service finally does not secretly issue C stop-laptops. Actual
//! runtime resources must independently close; unresolved owners stay retained.
use super::*;

/// Created only at the checked core-service close point below. This borrows
/// the actual Arc; it cannot be constructed from wire data or metadata closure.
pub(in crate::installing_broker) struct ClosedBrokerResources<'a> {
    broker: &'a Arc<InstallingBroker>,
}
impl ClosedBrokerResources<'_> {
    pub(in crate::installing_broker) fn same_broker(&self, broker: &Arc<InstallingBroker>) -> bool {
        Arc::ptr_eq(self.broker, broker)
    }
}
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
            // Every actual core owner above is known closed, including Runtime
            // and signals. Metadata closure alone cannot create this witness.
            let closed = ClosedBrokerResources { broker };
            if let Some(offer) = &mut self.startup.owner.installation_offer
                && let Err(error) = offer.close_after_service(&closed)
            {
                errors.push(BrokerServiceError::InstallationOffer(error));
                return Err(());
            }
            Ok(BrokerServiceClosed {
                termination_signal: signal,
            })
        } else {
            Err(())
        }
    }
}
