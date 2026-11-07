//! The real released Created owner enters the shared native viewer. Every
//! result retains the original accepted J, counted hold and started record.
use super::*;
use reverie_host::worker_laptop::{ViewerSession, ViewerStart};

#[must_use = "retain the whole created resource and original handler through finally"]
pub struct ViewingCold<'a> {
    owner: AllocationClosedCold<'a>,
    session: ViewerSession,
}

#[must_use = "viewer refusal retains the actual released allocation and resource owners"]
pub struct ColdViewerFailure<'a> {
    owner: AllocationClosedCold<'a>,
    cause: ColdError,
}

impl<'a> AllocationClosedCold<'a> {
    /// Only this actual allocation finalizer produces the input. The native
    /// constructor checks its original J again before publishing a Job.
    pub fn start_viewer(self) -> Result<ViewingCold<'a>, Box<ColdViewerFailure<'a>>> {
        let connection = &self.scope.preparing.admitted.request.connection;
        let result = self
            .started
            .network
            .start_viewer(&self.started.pane, connection);
        let cause = match result {
            Ok(ViewerStart::Started(session)) => {
                return Ok(ViewingCold {
                    owner: self,
                    session,
                });
            }
            Ok(ViewerStart::Retained) => {
                ColdBody::phase_refused(&self.started.network, "WORKER_COLD_VIEWER_UNCONFIRMED")
            }
            Err(cause) => cause.into(),
        };
        Err(Box::new(ColdViewerFailure { owner: self, cause }))
    }
}

impl ViewingCold<'_> {
    pub(in crate::installing_broker::launch) fn broker(&self) -> &InstallingBroker {
        self.owner.scope.preparing.broker()
    }
    pub(in crate::installing_broker::launch) fn relay_connection(
        &self,
    ) -> &Arc<reverie_host::worker_reports::WorkerLaunchConnection> {
        &self.owner.scope.preparing.admitted.request.connection
    }
    pub(in crate::installing_broker::launch) fn viewer_session(&self) -> &ViewerSession {
        &self.session
    }
}

impl std::fmt::Debug for ColdViewerFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("ColdViewerFailure")
            .field("cause", &self.cause)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for ColdViewerFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for ColdViewerFailure<'_> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
