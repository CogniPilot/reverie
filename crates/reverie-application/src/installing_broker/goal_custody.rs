//! The real G handler keeps its accepted Record/Hold until native calls, private
//! descriptors and the original socket are known closed. No global stop ACK.
use super::*;
use reverie_host::{
    goal_custody::{GoalCustodyAttempt, GoalCustodyError},
    worker_reports::{
        WorkerLaunchHold, WorkerReportError, WorkerServiceConnection, WorkerServicePurpose,
    },
};
use std::{
    fmt,
    time::{Duration, Instant},
};
#[cfg(test)]
mod tests;
#[derive(Debug)]
enum Error {
    Native(GoalCustodyError),
    Report(WorkerReportError),
    Configuration(GateError),
}
impl Error {
    fn code(&self) -> &'static str {
        match self {
            Self::Native(error) => error.code(),
            Self::Report(_) => "Goal custody caller unavailable",
            Self::Configuration(_) => "Worker policy unavailable",
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Native(error) => error,
            Self::Report(error) => error,
            Self::Configuration(error) => error,
        })
    }
}
struct Handler {
    connection: WorkerServiceConnection,
    hold: Option<WorkerLaunchHold>,
    native: Option<GoalCustodyAttempt>,
}
pub struct GoalCustodyHandlerClosed {
    primary: Option<Error>,
}
impl GoalCustodyHandlerClosed {
    pub fn primary_error_code(&self) -> Option<&'static str> {
        self.primary.as_ref().map(Error::code)
    }
}
pub struct GoalCustodyHandlerFailure {
    owner: Option<Handler>,
    primary: Option<Error>,
    cleanup: Vec<Error>,
}
impl fmt::Debug for GoalCustodyHandlerFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("GoalCustodyHandlerFailure")
            .field("primary", &self.primary)
            .field("cleanup", &self.cleanup)
            .finish_non_exhaustive()
    }
}
impl fmt::Display for GoalCustodyHandlerFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("GOAL_CUSTODY_RETAINED")
    }
}
impl std::error::Error for GoalCustodyHandlerFailure {}
impl Drop for GoalCustodyHandlerFailure {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl InstallingBroker {
    pub fn handle_goal_custody(
        &self,
        connection: WorkerServiceConnection,
    ) -> Result<GoalCustodyHandlerClosed, Box<GoalCustodyHandlerFailure>> {
        let mut owner = Handler {
            connection,
            hold: None,
            native: None,
        };
        let origin = owner
            .connection
            .assert_service(&self.reports)
            .and_then(|()| {
                if owner.connection.purpose() == WorkerServicePurpose::GoalCustody
                    && owner.connection.same_runtime(&self.storage.runtime)
                {
                    Ok(())
                } else {
                    Err(WorkerReportError::Unconfirmed)
                }
            });
        if let Err(error) = origin {
            return Err(Box::new(GoalCustodyHandlerFailure {
                owner: Some(owner),
                primary: Some(Error::Report(error)),
                cleanup: Vec::new(),
            }));
        }
        match owner.connection.retain_lifecycle() {
            Ok(hold) => owner.hold = Some(hold),
            Err(error) => {
                return Err(Box::new(GoalCustodyHandlerFailure {
                    owner: Some(owner),
                    primary: Some(Error::Report(error)),
                    cleanup: Vec::new(),
                }));
            }
        }
        let body = self.goal_body(&mut owner);
        self.finish_goal(owner, body)
    }
    fn goal_body(&self, owner: &mut Handler) -> Result<Vec<u8>, Error> {
        owner.native = Some(
            self.goals
                .begin(&self.storage.runtime, &owner.connection)
                .map_err(Error::Native)?,
        );
        let current = self.configuration().map_err(Error::Configuration)?;
        let response = owner
            .native
            .as_mut()
            .expect("actual G resource")
            .project(
                &self.storage.runtime,
                current.source_path(),
                current.configuration(),
            )
            .map_err(Error::Native)?;
        let fresh = self.configuration().map_err(Error::Configuration)?;
        if !reverie_contracts::worker_config::equivalent(
            current.configuration(),
            fresh.configuration(),
        ) {
            return Err(Error::Native(GoalCustodyError::Refused(
                "Worker policy changed; Goal bootstrap unavailable",
            )));
        }
        Ok(response)
    }
    fn finish_goal(
        &self,
        mut owner: Handler,
        body: Result<Vec<u8>, Error>,
    ) -> Result<GoalCustodyHandlerClosed, Box<GoalCustodyHandlerFailure>> {
        let mut cleanup = Vec::new();
        let end = Instant::now() + Duration::from_secs(2);
        let end = self
            .storage
            .runtime
            .stop_deadline()
            .map_or(end, |stop| end.min(stop));
        if let Some(native) = owner.native.as_mut()
            && let Err(error) = native.close(&self.storage.runtime, end)
        {
            cleanup.push(Error::Native(error));
        }
        let primary = match body {
            Ok(response) if cleanup.is_empty() => owner
                .connection
                .reply_json(&response)
                .err()
                .map(Error::Report),
            Ok(_) => owner
                .connection
                .report_failure("Private Goal cleanup unconfirmed")
                .err()
                .map(Error::Report),
            Err(error) => {
                if let Err(delivery) = owner.connection.report_failure(error.code()) {
                    cleanup.push(Error::Report(delivery));
                }
                Some(error)
            }
        };
        if let Err(error) = owner.connection.close_socket_for_worker() {
            cleanup.push(Error::Report(error));
        }
        if cleanup.is_empty()
            && let Some(hold) = owner.hold.as_mut()
            && let Err(error) = hold.release_for_worker()
        {
            cleanup.push(Error::Report(error));
        }
        if cleanup.is_empty() {
            Ok(GoalCustodyHandlerClosed { primary })
        } else {
            Err(Box::new(GoalCustodyHandlerFailure {
                owner: Some(owner),
                primary,
                cleanup,
            }))
        }
    }
}
