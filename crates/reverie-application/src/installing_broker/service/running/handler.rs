//! Fixed native handler and closed same-stack recovery consumer. No callback
//! selects a body, and neither a status answer nor join releases a resource.
use super::*;
use crate::installing_broker::launch::service::{HandlerReturned, run_service_launch};
use crate::installing_broker::{
    installation_offer::SharedInstallationOffer,
    resource_actor::{FleetDispatchFailure, PoolRegistrationFailure, ResourceOperationFailure},
};
use reverie_host::worker_reports::{
    AcceptedWorkerServiceConnection, RegisteredWorkerConnection, WorkerHandlerCommand,
    WorkerHandlerDisposition, WorkerHandlerInbox, WorkerServiceConnection, WorkerServicePurpose,
};
#[cfg(test)]
mod tests;

enum Retained<'a> {
    Control(Box<crate::installing_broker::control::ControlFailure<'a>>),
    Launch(HandlerReturned<'a>),
    Images(Box<ChatImageHandlerFailure>),
    Goal(Box<GoalCustodyHandlerFailure>),
    Registration(Box<PoolRegistrationFailure<'a>>),
    ResourceOperation(Box<ResourceOperationFailure<'a>>),
    FleetPreview(Box<FleetDispatchFailure<'a>>),
    Socket(WorkerServiceConnection),
}
struct Stack<'a> {
    broker: &'a Arc<InstallingBroker>,
    owner: Option<Retained<'a>>,
}
impl Stack<'_> {
    fn reconcile(&mut self) -> WorkerHandlerDisposition {
        self.owner = match self.owner.take() {
            Some(Retained::Control(mut owner)) => {
                if owner.reconcile() {
                    None
                } else {
                    Some(Retained::Control(owner))
                }
            }
            Some(Retained::Launch(mut owner)) => {
                if owner.reconcile() == WorkerHandlerDisposition::Finalized {
                    None
                } else {
                    Some(Retained::Launch(owner))
                }
            }
            Some(Retained::Socket(connection)) => {
                if connection.close_socket_for_worker().is_ok() {
                    None
                } else {
                    Some(Retained::Socket(connection))
                }
            }
            Some(Retained::Registration(owner)) => match owner.settle_for_worker() {
                Ok(closed) => {
                    eprintln!("{closed}");
                    None
                }
                Err(owner) => Some(Retained::Registration(owner)),
            },
            Some(Retained::ResourceOperation(owner)) => match owner.settle_for_worker() {
                Ok(closed) => {
                    if let Some(error) = closed.primary_error() {
                        eprintln!("{error}");
                    }
                    None
                }
                Err(owner) => Some(Retained::ResourceOperation(owner)),
            },
            Some(Retained::FleetPreview(owner)) => match owner.settle_for_worker() {
                Ok(closed) => {
                    if closed.primary_error_code().is_some() {
                        eprintln!("{closed}");
                    }
                    None
                }
                Err(owner) => Some(Retained::FleetPreview(owner)),
            },
            // These concrete domain failures retain their own original native
            // producers. No replay of observe/fetch/install is permitted here.
            other => other,
        };
        if self.owner.is_some() {
            WorkerHandlerDisposition::Retained
        } else {
            WorkerHandlerDisposition::Finalized
        }
    }
    fn cause(&self) -> Option<String> {
        match &self.owner {
            Some(Retained::Control(owner)) => Some(owner.to_string()),
            Some(Retained::Launch(owner)) => owner.diagnostics.last().cloned(),
            Some(Retained::Images(owner)) => Some(owner.to_string()),
            Some(Retained::Goal(owner)) => Some(owner.to_string()),
            Some(Retained::Registration(owner)) => Some(owner.to_string()),
            Some(Retained::ResourceOperation(owner)) => Some(owner.to_string()),
            Some(Retained::FleetPreview(owner)) => Some(owner.to_string()),
            Some(Retained::Socket(connection)) => {
                Some(format!("{:?}: socket close retained", connection.purpose()))
            }
            None => None,
        }
    }
}
impl Drop for Stack<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            // Unexpected unwind is negative quarantine, not a cleanup result.
            // Retain the actual broker backing every borrowed resource owner.
            // The normal path remains responsive to exact same-Job commands.
            std::mem::forget((Arc::clone(self.broker), owner));
        }
    }
}
pub(super) fn run(
    broker: Arc<InstallingBroker>,
    mut registered: RegisteredWorkerConnection,
    inbox: WorkerHandlerInbox,
    installation_offer: Option<SharedInstallationOffer>,
) {
    if let Err(error) = registered.await_handler_publication() {
        eprintln!("{error}");
        if let Err(cleanup) = registered.close_for_worker() {
            eprintln!("{cleanup}");
        }
        return;
    }
    let accepted = read(&broker, registered);
    let owner = match accepted {
        Ok(AcceptedWorkerServiceConnection::ReportCompleted) => None,
        Ok(AcceptedWorkerServiceConnection::Launch(connection)) => {
            let returned = run_service_launch(&broker, connection);
            for diagnostic in &returned.diagnostics {
                eprintln!("{diagnostic}");
            }
            returned
                .retained
                .is_some()
                .then_some(Retained::Launch(returned))
        }
        Ok(AcceptedWorkerServiceConnection::Service(connection))
            if connection.purpose() == WorkerServicePurpose::PoolRegistration =>
        {
            registration(&broker, connection, installation_offer.as_ref())
        }
        Ok(AcceptedWorkerServiceConnection::Service(connection))
            if connection.purpose() == WorkerServicePurpose::ResourceActor
                && reverie_contracts::resource_actor::is_fleet_maintenance_hello(
                    connection.request_bytes(),
                ) =>
        {
            fleet(&broker, connection, installation_offer.clone())
        }
        Ok(AcceptedWorkerServiceConnection::Service(connection)) => service(&broker, connection),
        Err(error) => {
            eprintln!("{error}");
            None
        }
    };
    let mut stack = Stack {
        broker: &broker,
        owner,
    };
    if let Some(cause) = stack.cause() {
        eprintln!("Worker handler retained: {cause}");
    }
    while stack.owner.is_some() {
        match inbox.receive() {
            Ok(request) => {
                let disposition = match request.command() {
                    WorkerHandlerCommand::Status => WorkerHandlerDisposition::Retained,
                    WorkerHandlerCommand::Reconcile => stack.reconcile(),
                };
                request.answer(disposition);
            }
            Err(error) => {
                // Broken publication/ownership cannot abandon the stack or
                // turn into successful thread completion.
                eprintln!("{error}");
                broker.request_stop();
                return;
            }
        }
    }
}
fn fleet<'a>(
    broker: &'a Arc<InstallingBroker>,
    connection: WorkerServiceConnection,
    offer: Option<SharedInstallationOffer>,
) -> Option<Retained<'a>> {
    if let Err(cause) = reverie_contracts::resource_actor::decode_fleet_maintenance_hello(
        connection.request_bytes(),
    ) {
        if let Err(error) = connection.report_failure(cause.code()) {
            eprintln!("{error}");
        }
        return match connection.close_socket_for_worker() {
            Ok(_) => None,
            Err(error) => {
                eprintln!("{error}");
                Some(Retained::Socket(connection))
            }
        };
    }
    match broker.handle_fleet_operation(connection, offer) {
        Ok(closed) => {
            if closed.primary_error_code().is_some() {
                eprintln!("{closed}");
            }
            None
        }
        Err(owner) => Some(Retained::FleetPreview(owner)),
    }
}

fn registration<'a>(
    broker: &'a Arc<InstallingBroker>,
    connection: WorkerServiceConnection,
    offer: Option<&'a SharedInstallationOffer>,
) -> Option<Retained<'a>> {
    let original_end = std::time::Instant::now() + std::time::Duration::from_secs(300);
    // The original accepted connection remains owned throughout lock/origin
    // refusal; no stream is cloned or second reader installed.
    let entered = offer.map_or_else(
        || {
            Err(BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_OFFER_REQUIRED",
            ))
        },
        |offer| offer.enter_registration(broker),
    );
    let failure = match entered {
        Ok(guard) => broker.handle_pool_registration(connection, guard, original_end),
        Err(cause) => broker.refuse_pool_registration(connection, cause, original_end),
    };
    eprintln!("{failure}");
    match failure.settle_for_worker() {
        Ok(closed) => {
            eprintln!("{closed}");
            None
        }
        Err(owner) => Some(Retained::Registration(owner)),
    }
}
fn read(
    broker: &InstallingBroker,
    registered: RegisteredWorkerConnection,
) -> Result<AcceptedWorkerServiceConnection, WorkerDispatchError> {
    if !registered.same_runtime(&broker.storage.runtime) {
        let cleanup = registered.close_for_worker().err();
        return Err(WorkerDispatchError::Configuration {
            primary: GateError::Refused("WORKER_HANDLER_RUNTIME_CHANGED"),
            cleanup,
        });
    }
    let snapshot = match broker.configuration() {
        Ok(snapshot) => snapshot,
        Err(primary) => {
            let cleanup = registered.close_for_worker().err();
            return Err(WorkerDispatchError::Configuration { primary, cleanup });
        }
    };
    Ok(registered
        .receive_service_for_worker(broker.command_telemetry(), snapshot.configuration())?)
}
fn service<'a>(
    broker: &'a Arc<InstallingBroker>,
    connection: WorkerServiceConnection,
) -> Option<Retained<'a>> {
    match connection.purpose() {
        WorkerServicePurpose::Control => match broker.handle_control(connection) {
            Ok(()) => None,
            Err(mut owner) => {
                if owner.reconcile_known_refusal() {
                    eprintln!("{owner}");
                    None
                } else {
                    Some(Retained::Control(owner))
                }
            }
        },
        WorkerServicePurpose::ChatImages => match broker.handle_chat_images(connection) {
            Ok(closed) => {
                if let Some(error) = closed.primary_error() {
                    eprintln!("{error}");
                }
                None
            }
            Err(owner) => Some(Retained::Images(owner)),
        },
        WorkerServicePurpose::GoalCustody => match broker.handle_goal_custody(connection) {
            Ok(closed) => {
                if let Some(error) = closed.primary_error_code() {
                    eprintln!("{error}");
                }
                None
            }
            Err(owner) => Some(Retained::Goal(owner)),
        },
        WorkerServicePurpose::ResourceActor => match broker.handle_resource_operation(connection) {
            Ok(closed) => {
                if let Some(error) = closed.primary_error() {
                    eprintln!("{error}");
                }
                None
            }
            Err(owner) => Some(Retained::ResourceOperation(owner)),
        },
        // Actual L/C/Y consumers are separate mandatory joins, not a public
        // request/UID substitute. This unselected running cut advertises NO
        // all-verb readiness. Preserve failure and checked socket uncertainty.
        _ => {
            if let Err(error) =
                connection.report_failure("WORKER_NATIVE_MANDATORY_CONSUMER_REQUIRED")
            {
                eprintln!("{error}");
            }
            match connection.close_socket_for_worker() {
                Ok(_) => None,
                Err(error) => {
                    eprintln!("{error}");
                    Some(Retained::Socket(connection))
                }
            }
        }
    }
}
