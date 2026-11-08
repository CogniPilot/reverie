//! Fixed service J body. Every exit returns its actual whole cleanup owner.
use super::*;
use reverie_host::worker_reports::WorkerHandlerDisposition;

pub(in crate::installing_broker) enum HandlerRetained<'a> {
    Admission(Box<LaunchAdmissionFailure<'a>>),
    Reuse(Box<ReuseFinalizationFailure<'a>>),
    Cold(Box<ColdFinalizationFailure<'a>>),
}
pub(in crate::installing_broker) struct HandlerReturned<'a> {
    pub(in crate::installing_broker) retained: Option<HandlerRetained<'a>>,
    pub(in crate::installing_broker) diagnostics: Vec<String>,
}
impl HandlerReturned<'_> {
    pub(in crate::installing_broker) fn reconcile(&mut self) -> WorkerHandlerDisposition {
        let Some(owner) = self.retained.take() else {
            return WorkerHandlerDisposition::Finalized;
        };
        self.retained = match owner {
            HandlerRetained::Cold(owner) => match owner.reconcile_handler() {
                Ok(closed) => {
                    if let Some(cause) = closed.primary_error() {
                        self.diagnostics.push(cause.to_string());
                    }
                    None
                }
                Err(owner) => Some(HandlerRetained::Cold(owner)),
            },
            HandlerRetained::Reuse(owner) => match owner.reconcile_handler() {
                Ok(closed) => {
                    if let Some(cause) = closed.primary_error() {
                        self.diagnostics.push(cause.to_string());
                    }
                    None
                }
                Err(owner) => Some(HandlerRetained::Reuse(owner)),
            },
            HandlerRetained::Admission(owner) => match owner.request.close_for_worker() {
                Ok(()) => None,
                Err(_) => Some(HandlerRetained::Admission(owner)),
            },
        };
        if self.retained.is_some() {
            WorkerHandlerDisposition::Retained
        } else {
            WorkerHandlerDisposition::Finalized
        }
    }
}
struct RunningHandler {
    connection: Arc<WorkerLaunchConnection>,
    diagnostics: Vec<String>,
}
pub(in crate::installing_broker) fn run_service_launch(
    broker: &InstallingBroker,
    connection: WorkerLaunchConnection,
) -> HandlerReturned<'_> {
    run_launch(ReceivedWorkerLaunch {
        broker,
        connection: Arc::new(connection),
    })
}
pub(in crate::installing_broker::launch) fn run_launch(
    received: ReceivedWorkerLaunch<'_>,
) -> HandlerReturned<'_> {
    let mut handler = RunningHandler {
        connection: received.connection.clone(),
        diagnostics: Vec::new(),
    };
    let admitted = match received.begin_ordinary() {
        Ok(admitted) => admitted,
        Err(failure) => {
            handler.report(failure.cause());
            let retained = match failure.request.close_for_worker() {
                Ok(()) => None,
                Err(error) => {
                    handler.note(&error);
                    Some(HandlerRetained::Admission(failure))
                }
            };
            return handler.returned(retained);
        }
    };
    let inspected = match admitted.prepare_prefix() {
        Ok(inspected) => inspected,
        Err(failure) => return handler.preparation_failure(failure),
    };
    match inspected.classify_existing() {
        Ok(ClassifiedWorkerLaunch::Reuse(reuse)) => handler.reuse(reuse),
        Ok(ClassifiedWorkerLaunch::Cold(cold)) => handler.cold(cold),
        Err(failure) => handler.preparation_failure(failure),
    }
}

impl RunningHandler {
    fn note(&mut self, error: &dyn std::fmt::Display) {
        self.diagnostics.push(error.to_string());
    }
    fn report(&mut self, error: &dyn std::fmt::Display) {
        let message = error.to_string();
        if let Err(delivery) = self.connection.report_handler_failure(&message) {
            self.note(&delivery);
        }
        self.diagnostics.push(message);
    }
    fn returned(self, retained: Option<HandlerRetained<'_>>) -> HandlerReturned<'_> {
        HandlerReturned {
            retained,
            diagnostics: self.diagnostics,
        }
    }
    fn preparation_failure<'a>(
        mut self,
        failure: Box<LaunchPreparationFailure<'a>>,
    ) -> HandlerReturned<'a> {
        self.report(failure.as_ref());
        self.cold_finalized(failure.finalize_for_worker())
    }
    fn reuse(mut self, reuse: ReusableWorkerLaunch<'_>) -> HandlerReturned<'_> {
        let prepared = match reuse.prepare_viewer() {
            Ok(prepared) => prepared,
            Err(failure) => return self.reuse_failure(failure),
        };
        let closed = match prepared.close_allocation() {
            Ok(closed) => closed,
            Err(failure) => return self.reuse_failure(failure),
        };
        let viewing = match closed.start_for_worker() {
            Ok(viewing) => viewing,
            Err(failure) => return self.reuse_failure(failure),
        };
        let (viewing, outcome) = viewing.relay().into_parts();
        self.relay_outcome(outcome);
        self.reuse_finalized(viewing.finalize_for_worker())
    }
    fn reuse_failure(mut self, failure: Box<ReuseViewerFailure<'_>>) -> HandlerReturned<'_> {
        self.report(failure.as_ref());
        self.reuse_finalized(failure.finalize_for_worker())
    }
    fn reuse_finalized(
        mut self,
        result: Result<ReuseHandlerClosed, Box<ReuseFinalizationFailure<'_>>>,
    ) -> HandlerReturned<'_> {
        let retained = match result {
            Ok(closed) => {
                if let Some(primary) = closed.primary_error() {
                    self.note(primary);
                }
                None
            }
            Err(failure) => {
                self.note(failure.as_ref());
                Some(HandlerRetained::Reuse(failure))
            }
        };
        self.returned(retained)
    }
    fn cold(self, cold: ColdWorkerLaunch<'_>) -> HandlerReturned<'_> {
        let closed = match cold.prepare_cold() {
            Ok(closed) => closed,
            Err(failure) => return self.cold_failure(failure),
        };
        let viewing = match closed.start_viewer() {
            Ok(viewing) => viewing,
            Err(failure) => return self.cold_viewer_failure(failure),
        };
        self.cold_viewing(viewing)
    }
    fn cold_failure(mut self, failure: Box<ColdLaunchFailure<'_>>) -> HandlerReturned<'_> {
        self.report(failure.as_ref());
        self.cold_finalized(failure.finalize_for_worker())
    }
    fn cold_viewer_failure(mut self, failure: Box<ColdViewerFailure<'_>>) -> HandlerReturned<'_> {
        self.report(failure.as_ref());
        self.cold_finalized(failure.finalize_for_worker())
    }
    fn cold_viewing(mut self, viewing: ViewingCold<'_>) -> HandlerReturned<'_> {
        let (viewing, outcome) = viewing.relay().into_parts();
        self.relay_outcome(outcome);
        self.cold_finalized(viewing.finalize_for_worker())
    }
    fn cold_finalized(
        mut self,
        result: Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'_>>>,
    ) -> HandlerReturned<'_> {
        let retained = match result {
            Ok(closed) => {
                if let Some(primary) = closed.primary_error() {
                    self.note(primary);
                }
                None
            }
            Err(failure) => {
                self.note(failure.as_ref());
                Some(HandlerRetained::Cold(failure))
            }
        };
        self.returned(retained)
    }
    fn relay_outcome(
        &mut self,
        outcome: Result<reverie_host::worker_reports::ViewerRelayEnd, ReuseRelayError>,
    ) {
        match outcome {
            Err(error @ ReuseRelayError::Configuration(_)) => self.report(&error),
            Err(error @ ReuseRelayError::Transport(_)) => self.note(&error),
            Ok(_) => (),
        }
    }
}
