//! Genuine incoming L transport, still unbound to a Q operation. Its private
//! origin remains L through the common native transport; ordinary admission
//! must refuse it. No parsed reference, request or digest is a start grant.
use super::*;
mod peer;
pub use peer::{ProtectedLaunchPeerFailure, ProtectedLaunchPeerPin};
use reverie_contracts::{
    worker_config::EffectiveWorkerConfig, worker_launch::ProtectedWorkerRequest,
};
use reverie_core::{ids::NativeOperationId, operations::JournalDigest};

pub struct WorkerProtectedLaunchConnection {
    connection: Arc<WorkerLaunchConnection>,
    reference: NativeOperationId,
    request_digest: JournalDigest,
}
pub struct ProtectedLaunchDecodeFailure {
    connection: WorkerServiceConnection,
    cause: WorkerReportError,
}
/// The SAME original L Record is counted before native peer qualification or
/// operation attachment. This contains no Q grant or protected admission.
#[must_use = "transfer the original hold with the whole launch; default drop retains its slot"]
pub struct HeldProtectedWorkerLaunch {
    incoming: WorkerProtectedLaunchConnection,
    hold: WorkerLaunchHold,
    peer_pin_attempted: bool,
}
pub struct ProtectedLaunchHoldFailure {
    incoming: WorkerProtectedLaunchConnection,
    cause: WorkerReportError,
}
impl ProtectedLaunchHoldFailure {
    pub fn cause(&self) -> &WorkerReportError {
        &self.cause
    }
    pub fn into_parts(self) -> (WorkerProtectedLaunchConnection, WorkerReportError) {
        (self.incoming, self.cause)
    }
}
impl ProtectedLaunchDecodeFailure {
    pub fn cause(&self) -> &WorkerReportError {
        &self.cause
    }
    pub fn into_parts(self) -> (WorkerServiceConnection, WorkerReportError) {
        (self.connection, self.cause)
    }
}
impl WorkerServiceConnection {
    pub fn decode_protected_launch(
        self,
        configuration: &EffectiveWorkerConfig,
    ) -> std::result::Result<WorkerProtectedLaunchConnection, Box<ProtectedLaunchDecodeFailure>>
    {
        if self.purpose() != WorkerServicePurpose::ProtectedLaunch {
            return Err(Box::new(ProtectedLaunchDecodeFailure {
                connection: self,
                cause: WorkerReportError::LaunchKind,
            }));
        }
        let decoded = match ProtectedWorkerRequest::decode(self.request_bytes(), configuration) {
            Ok(decoded) => decoded,
            Err(cause) => {
                return Err(Box::new(ProtectedLaunchDecodeFailure {
                    connection: self,
                    cause: WorkerReportError::Launch(cause),
                }));
            }
        };
        let (reference, request, request_digest) = decoded.into_parts();
        Ok(WorkerProtectedLaunchConnection {
            connection: Arc::new(self.delegate_protected(request)),
            reference,
            request_digest,
        })
    }
}
impl WorkerProtectedLaunchConnection {
    pub fn retain_for_qualification(
        self,
    ) -> std::result::Result<HeldProtectedWorkerLaunch, Box<ProtectedLaunchHoldFailure>> {
        match self.connection.retain_lifecycle() {
            Ok(hold) => Ok(HeldProtectedWorkerLaunch {
                incoming: self,
                hold,
                peer_pin_attempted: false,
            }),
            Err(cause) => Err(Box::new(ProtectedLaunchHoldFailure {
                incoming: self,
                cause,
            })),
        }
    }
    pub fn assert_service(&self, expected: &Arc<WorkerReportService>) -> Result<()> {
        let super::launch::LaunchOrigin::Protected(source) = &self.connection.origin else {
            unreachable!("actual L source retained")
        };
        source.assert_service(expected)
    }
    pub fn reference(&self) -> &NativeOperationId {
        &self.reference
    }
    pub fn request_digest(&self) -> &JournalDigest {
        &self.request_digest
    }
    pub fn connection(&self) -> &Arc<WorkerLaunchConnection> {
        &self.connection
    }
    pub fn peer(&self) -> &WorkerPeer {
        let super::launch::LaunchOrigin::Protected(source) = &self.connection.origin else {
            unreachable!("actual L constructor preserves its original source")
        };
        source.peer()
    }
    pub fn into_parts(
        self,
    ) -> (
        Arc<WorkerLaunchConnection>,
        NativeOperationId,
        JournalDigest,
    ) {
        (self.connection, self.reference, self.request_digest)
    }
}
impl HeldProtectedWorkerLaunch {
    pub fn incoming(&self) -> &WorkerProtectedLaunchConnection {
        &self.incoming
    }
    pub fn assert_current(&self, runtime: &WorkerRuntime) -> Result<()> {
        self.incoming.connection.assert_open(runtime)?;
        self.incoming.connection.assert_protected_origin()?;
        self.incoming.connection.assert_lifecycle_hold(&self.hold)
    }
    pub fn into_parts(
        self,
    ) -> (
        Arc<WorkerLaunchConnection>,
        NativeOperationId,
        JournalDigest,
        WorkerLaunchHold,
    ) {
        let (connection, reference, digest) = self.incoming.into_parts();
        (connection, reference, digest, self.hold)
    }
}
