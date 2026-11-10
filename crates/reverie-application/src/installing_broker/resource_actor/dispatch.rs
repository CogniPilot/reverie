//! The actual service consumer owns one original Q frame through dispatch and
//! checked cleanup. A failure never becomes a fresh request or an owner DTO.
use super::*;

enum Owner<'a> {
    Entry(Box<ResourceActorFailure<'a>>),
    Operation(Box<AuthenticatedResourceOperation<'a>>),
}
impl Owner<'_> {
    fn close(&mut self) -> Result<WorkerLaunchClose> {
        match self {
            Self::Entry(owner) => {
                let frame = &mut owner.frame;
                let end = frame
                    .broker
                    .storage
                    .runtime
                    .stop_budget()
                    .deadline()
                    .map_or(frame.deadline, |stop| frame.deadline.min(stop));
                frame.close(end)
            }
            Self::Operation(owner) => owner.close_for_worker(),
        }
    }
    fn into_primary(self) -> Option<ResourceActorError> {
        match self {
            Self::Entry(owner) => Some(owner.cause),
            Self::Operation(_) => None,
        }
    }
}
pub struct ResourceOperationClosed {
    primary: Option<ResourceActorError>,
}
impl ResourceOperationClosed {
    pub fn primary_error(&self) -> Option<&ResourceActorError> {
        self.primary.as_ref()
    }
}
/// Retains the SAME failed entry or authenticated frame, Record and Hold.
#[must_use = "retain this whole failure until its original components settle"]
pub struct ResourceOperationFailure<'a> {
    owner: Owner<'a>,
    primary: Option<ResourceActorError>,
    first_cleanup: Option<ResourceActorError>,
    cleanup_failures: u64,
}
impl<'a> ResourceOperationFailure<'a> {
    pub(super) fn from_entry(owner: Box<ResourceActorFailure<'a>>) -> Box<Self> {
        retained(Owner::Entry(owner), None)
    }
    /// Selective same-owner component settlement only: no request, reply,
    /// profile write, native effect or operation dispatch is replayed.
    pub fn settle_for_worker(
        mut self: Box<Self>,
    ) -> std::result::Result<ResourceOperationClosed, Box<Self>> {
        let closed = match self.owner.close() {
            Ok(WorkerLaunchClose::SocketClosedLifecycleHeld) => Err(ResourceActorError::Channel(
                reverie_host::worker_reports::WorkerReportError::LifecycleRetained,
            )),
            result => result,
        };
        if let Err(cause) = closed {
            // Every actual producer remains inside owner. Keep the original
            // typed close tree, rather than allocating another copy of the
            // same sticky causes on every reconciliation request.
            self.cleanup_failures = self.cleanup_failures.saturating_add(1);
            self.first_cleanup.get_or_insert(cause);
            return Err(self);
        }
        let mut primary = self.owner.into_primary().or(self.primary);
        if let Some(cause) = self.first_cleanup {
            primary = Some(match primary {
                None => cause,
                Some(body) => ResourceActorError::Finalization {
                    primary: Box::new(body),
                    secondary: Box::new(cause),
                },
            });
        }
        Ok(ResourceOperationClosed { primary })
    }
}
impl std::fmt::Display for ResourceOperationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.owner {
            Owner::Entry(owner) => write!(out, "Q entry retained: {}", owner.cause())?,
            Owner::Operation(owner) => write!(
                out,
                "Q request {} retained",
                owner.request().request_id().as_str()
            )?,
        }
        if let Some(primary) = &self.primary {
            write!(out, ": {primary}")?;
        }
        if let Some(cause) = &self.first_cleanup {
            write!(
                out,
                "; cleanup: {cause}; failed closes: {}",
                self.cleanup_failures
            )?;
        }
        Ok(())
    }
}
impl std::fmt::Debug for ResourceOperationFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, out)
    }
}
impl std::error::Error for ResourceOperationFailure<'_> {}

impl InstallingBroker {
    pub fn handle_resource_operation(
        &self,
        connection: WorkerServiceConnection,
    ) -> std::result::Result<ResourceOperationClosed, Box<ResourceOperationFailure<'_>>> {
        let website = match self.prepare_resource_website(connection) {
            Ok(website) => website,
            Err(owner) => return ResourceOperationFailure::from_entry(owner).settle_for_worker(),
        };
        let mut operation = match website.receive_operation() {
            Ok(owner) => Box::new(owner),
            Err(owner) => return ResourceOperationFailure::from_entry(owner).settle_for_worker(),
        };
        let body = dispatch(&mut operation);
        retained(Owner::Operation(operation), body.err()).settle_for_worker()
    }
}
fn retained<'a>(
    owner: Owner<'a>,
    primary: Option<ResourceActorError>,
) -> Box<ResourceOperationFailure<'a>> {
    Box::new(ResourceOperationFailure {
        owner,
        primary,
        first_cleanup: None,
        cleanup_failures: 0,
    })
}
fn dispatch(operation: &mut AuthenticatedResourceOperation<'_>) -> Result<()> {
    let reply = match operation.request().selection() {
        ResourceRequestSelection::EmployeeStatus { .. } => operation.employee_status_reply(),
        ResourceRequestSelection::GpuStatus { .. }
        | ResourceRequestSelection::GpuRequest { .. } => operation.gpu_reply(),
        ResourceRequestSelection::Preview { .. } => operation.preview_reply(),
        ResourceRequestSelection::Apply { .. } => {
            operation.assert_current()?;
            let reply = operation
                .request()
                .refusal_reply("RESOURCE_RAM_NATIVE_CONTINUATION_REQUIRED")?;
            operation.send_operation_reply(&reply)?;
            return Err(ResourceActorError::Refused(
                "RESOURCE_RAM_NATIVE_CONTINUATION_REQUIRED",
            ));
        }
    };
    match reply {
        Ok(reply) => operation.send_operation_reply(&reply),
        Err(primary) => {
            // At most one refusal attempt. If original native/owner checks
            // failed, send's real guards may refuse as well; retain both.
            let refused = operation
                .request()
                .refusal_reply("RESOURCE_OPERATION_UNCONFIRMED_KEEP_CLAIM")?;
            let sent = operation.send_operation_reply(&refused);
            error::finalized(Err(primary), sent)
        }
    }
}
