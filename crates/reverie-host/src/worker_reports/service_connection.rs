//! Other original broker verbs retain the SAME authenticated accepted record.
//! Payload and peer facts are DATA, never a launcher or resource permit.
use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerServicePurpose {
    ChatImages,
    ResumeRegistration,
    ResourceActor,
    PoolRegistration,
    GoalCustody,
    Control,
    ProtectedLaunch,
}
impl WorkerServicePurpose {
    pub(super) fn from_kind(kind: u8) -> Option<Self> {
        Some(match kind {
            b'M' => Self::ChatImages,
            b'Y' => Self::ResumeRegistration,
            b'Q' => Self::ResourceActor,
            b'B' => Self::PoolRegistration,
            b'G' => Self::GoalCustody,
            b'C' => Self::Control,
            b'L' => Self::ProtectedLaunch,
            _ => return None,
        })
    }
}

/// Minted solely by the actual kernel SO_PEERCRED read, after configured UID
/// comparison. These facts do not replace each purpose's further peer policy.
#[derive(Clone, Copy, Debug)]
pub struct WorkerPeer {
    pub(super) uid: u32,
    pub(super) gid: u32,
    pub(super) pid: i32,
}
impl WorkerPeer {
    pub fn uid(&self) -> u32 {
        self.uid
    }
    pub fn gid(&self) -> u32 {
        self.gid
    }
    pub fn pid(&self) -> i32 {
        self.pid
    }
}

pub(super) enum InitialRequest {
    ReportCompleted,
    Launch(reverie_contracts::worker_launch::WorkerRequest),
    Service {
        purpose: WorkerServicePurpose,
        payload: Vec<u8>,
        peer: WorkerPeer,
    },
}
pub enum AcceptedWorkerServiceConnection {
    ReportCompleted,
    Launch(WorkerLaunchConnection),
    Service(WorkerServiceConnection),
}

#[must_use = "the original accepted stream remains in its counted record"]
pub struct WorkerServiceConnection {
    pub(super) service: Arc<WorkerReportService>,
    pub(super) record: Arc<Record>,
    purpose: WorkerServicePurpose,
    payload: Vec<u8>,
    peer: WorkerPeer,
    ownership: SocketOwnership,
}
enum SocketOwnership {
    Direct,
    ProtectedLaunch,
}
impl WorkerServiceConnection {
    pub(super) fn delegate_protected(
        mut self,
        request: reverie_contracts::worker_launch::WorkerRequest,
    ) -> WorkerLaunchConnection {
        self.ownership = SocketOwnership::ProtectedLaunch;
        WorkerLaunchConnection::from_protected(self, request)
    }

    pub(super) fn new(
        service: Arc<WorkerReportService>,
        record: Arc<Record>,
        purpose: WorkerServicePurpose,
        payload: Vec<u8>,
        peer: WorkerPeer,
    ) -> Self {
        Self {
            service,
            record,
            purpose,
            payload,
            peer,
            ownership: SocketOwnership::Direct,
        }
    }
    pub fn purpose(&self) -> WorkerServicePurpose {
        self.purpose
    }
    pub fn request_bytes(&self) -> &[u8] {
        &self.payload
    }
    pub fn peer(&self) -> &WorkerPeer {
        &self.peer
    }
    pub fn same_runtime(&self, runtime: &WorkerRuntime) -> bool {
        Arc::ptr_eq(&self.service.engine, runtime.installed_engine())
    }
    /// Pure expected-service identity. A second same-engine service/registry
    /// cannot supply this installing broker's actual accepted record.
    pub fn assert_service(&self, expected: &Arc<WorkerReportService>) -> Result<()> {
        if Arc::ptr_eq(&self.service, expected) {
            Ok(())
        } else {
            Err(WorkerReportError::Unconfirmed)
        }
    }
    /// Issue the existing SAME-record logical hold before a purpose opens or
    /// delegates resource work. It grants no actor/file/native permission.
    pub fn retain_lifecycle(&self) -> Result<WorkerLaunchHold> {
        self.record.retain_lifecycle(&self.service)
    }
    /// Internal purposes retain this exact accepted Record after its genuine
    /// logical hold is issued. Peer/PID data alone cannot mint this identity.
    pub(crate) fn held_identity(&self) -> Result<terminal::RelayIdentity> {
        self.record.require_terminal_hold()?;
        Ok(terminal::RelayIdentity::new(
            &self.service,
            self.record.clone(),
        ))
    }
    /// Physical socket finalization remains distinct from held resource work
    /// and this actual handler's JoinHandle. No implicit hold release occurs.
    pub fn close_socket_for_worker(&self) -> Result<WorkerLaunchClose> {
        self.service.close_record_socket_budget(
            &self.record,
            &super::budget::CleanupBudget::worker(&self.service),
        )
    }
    /// Only the fixed J response kind is available; no descriptor or arbitrary
    /// frame writer escapes the authenticated purpose owner.
    pub fn reply_json(&self, bytes: &[u8]) -> Result<()> {
        let mut stream = self.record.terminal_stream()?;
        wire::send(
            &self.service,
            stream.as_mut().ok_or(WorkerReportError::Unconfirmed)?,
            b'J',
            bytes,
        )
    }
    pub fn report_failure(&self, message: &str) -> Result<()> {
        let mut stream = self.record.terminal_stream()?;
        wire::send(
            &self.service,
            stream.as_mut().ok_or(WorkerReportError::Unconfirmed)?,
            b'E',
            &message.as_bytes()[..message.len().min(1000)],
        )
    }
    pub fn close_for_worker(self) -> Result<()> {
        self.service.finish_accepted_for_worker(&self.record)
    }
}
impl Drop for WorkerServiceConnection {
    fn drop(&mut self) {
        // Default destruction is a checked negative path, not a purpose result
        // or authority to release a delegated resource/channel lifetime.
        if matches!(self.ownership, SocketOwnership::Direct) {
            let _ = self.service.finish_accepted_for_worker(&self.record);
        }
    }
}
