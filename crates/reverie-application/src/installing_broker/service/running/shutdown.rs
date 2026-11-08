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
#[cfg(test)]
mod tests;
/// Results of the same original broker-owned component finalizers. Fields are
/// private; callers cannot construct closure from metadata or a boolean.
pub(in crate::installing_broker) struct BrokerIoClosure {
    reports: bool,
    telemetry: bool,
    images: bool,
    recovery: bool,
}
impl BrokerIoClosure {
    pub(in crate::installing_broker) fn reports_closed(&self) -> bool {
        self.reports
    }
    pub(in crate::installing_broker) fn recovery_closed(&self) -> bool {
        self.recovery
    }
    pub(in crate::installing_broker) fn all_closed(&self) -> bool {
        self.reports && self.telemetry && self.images && self.recovery
    }
}
impl InstallingBroker {
    pub(in crate::installing_broker) fn close_application_io(
        &self,
        end: std::time::Instant,
        errors: &mut Vec<BrokerServiceError>,
    ) -> BrokerIoClosure {
        let reports = record_close(
            self.reports.close(end).map_err(BrokerServiceError::Handler),
            errors,
        );
        let telemetry = record_close(
            self.close_command_telemetry(end)
                .map_err(BrokerServiceError::Telemetry),
            errors,
        );
        let images = record_close(
            self.close_chat_images(end)
                .map_err(BrokerServiceError::Images),
            errors,
        );
        let recovery = record_close(
            self.recovery
                .close_service_owners(self, end)
                .map_err(BrokerServiceError::Recovery),
            errors,
        );
        BrokerIoClosure {
            reports,
            telemetry,
            images,
            recovery,
        }
    }
}

impl BrokerService {
    pub(super) fn shutdown(
        &mut self,
        errors: &mut Vec<BrokerServiceError>,
    ) -> Result<BrokerServiceClosed, ()> {
        // Full finally is admitted once. Reconciliation must address original
        // remaining owners, never replay this entire pass or its body.
        if self.shutdown_attempted {
            return Err(());
        }
        self.shutdown_attempted = true;
        let end = self.startup.owner.broker.storage.runtime.request_stop();
        let signal = self
            .startup
            .owner
            .signals
            .as_ref()
            .and_then(BrokerSignals::termination_signal);
        let components_closed = self.close_application_components(end, errors);
        let broker = &self.startup.owner.broker;
        let runtime_closed = if components_closed {
            record_close(
                broker
                    .storage
                    .runtime
                    .close(end)
                    .map_err(BrokerServiceError::Runtime),
                errors,
            )
        } else {
            // All original native tickets are attempted, while cleanup
            // admission remains usable by unresolved actual App/report owners.
            record_close(
                broker
                    .storage
                    .runtime
                    .settle_owned(end)
                    .map_err(BrokerServiceError::Runtime),
                errors,
            );
            false
        };
        let signals_closed = if runtime_closed {
            record_close(
                self.startup
                    .owner
                    .signals
                    .as_mut()
                    .map_or(Ok(()), BrokerSignals::finish_after_runtime_close)
                    .map_err(BrokerServiceError::Signal),
                errors,
            )
        } else {
            false
        };
        if components_closed && runtime_closed && signals_closed {
            // Only actual close results produce the same-Arc witness. A
            // historical body error neither grants nor disproves closure.
            let closed = ClosedBrokerResources { broker };
            if let Some(offer) = &mut self.startup.owner.installation_offer {
                record_close(
                    offer
                        .close_after_service(&closed)
                        .map_err(BrokerServiceError::InstallationOffer),
                    errors,
                );
            }
        } else {
            // Component-only metadata close never releases the actual broker.
            record_close(
                self.startup
                    .owner
                    .close_installation_origin_metadata()
                    .map_err(BrokerServiceError::InstallationOffer),
                errors,
            );
        }
        if errors.is_empty() {
            Ok(BrokerServiceClosed {
                termination_signal: signal,
            })
        } else {
            Err(())
        }
    }
    fn close_application_components(
        &mut self,
        end: std::time::Instant,
        errors: &mut Vec<BrokerServiceError>,
    ) -> bool {
        let broker = &self.startup.owner.broker;
        let listener = record_close(
            self.listener.close().map_err(BrokerServiceError::Listener),
            errors,
        );
        // Diagnostics survive, while only the actual final ReportService.close
        // result establishes closure of its socket/Hold/handler owners.
        record_close(
            broker
                .reports
                .interrupt_worker_handlers(end)
                .map_err(BrokerServiceError::Handler),
            errors,
        );
        record_close(
            broker
                .reports
                .reconcile_worker_handlers(end)
                .map(|_| ())
                .map_err(BrokerServiceError::Handler),
            errors,
        );
        let io = broker.close_application_io(end, errors);
        let supervisor = self.supervisor_closed();
        if !supervisor {
            errors.push(BrokerServiceError::Supervisor(
                "WORKER_SUPERVISOR_STOP_RETAINED".into(),
            ));
        }
        let controller = record_close(
            broker
                .close_installed_controller(
                    io.reports_closed() && io.recovery_closed() && supervisor,
                    end,
                )
                .map_err(BrokerServiceError::Controller),
            errors,
        );
        listener && io.all_closed() && supervisor && controller
    }
}
fn record_close(
    result: Result<(), BrokerServiceError>,
    errors: &mut Vec<BrokerServiceError>,
) -> bool {
    match result {
        Ok(()) => true,
        Err(error) => {
            errors.push(error);
            false
        }
    }
}
