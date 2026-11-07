//! One closed-purpose native work registry for this Company's request owners.
//! A cancelled HTTP future cannot drop its real seats or native job custody.
mod job;
use super::{OfficeError, Result, request::RequestLifetime};
use crate::installed_worker_engine::InstalledWorkerEngine;
pub(super) use job::{NativeJob, NativeValue};
use reverie_contracts::worker_recovery::OfficeAddressData;
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
pub(in crate::office) enum Purpose {
    Backend {
        engine: Arc<InstalledWorkerEngine>,
        name: String,
    },
    Socket(OfficeAddressData),
    Telemetry {
        collector: Arc<crate::command_telemetry::CommandTelemetry>,
        session: reverie_core::ids::ProfileSessionId,
        body: Vec<u8>,
    },
}
struct State {
    closed: bool,
    jobs: Vec<Arc<NativeJob>>,
}
pub(super) struct NativeJobs(Mutex<State>);
impl NativeJobs {
    pub(super) fn new() -> Self {
        Self(Mutex::new(State {
            closed: false,
            jobs: Vec::new(),
        }))
    }
    pub(super) fn backend(
        &self,
        engine: Arc<InstalledWorkerEngine>,
        name: String,
        lifetime: Arc<RequestLifetime>,
    ) -> Result<Arc<NativeJob>> {
        self.start(Purpose::Backend { engine, name }, lifetime)
    }
    pub(super) fn socket(
        &self,
        address: OfficeAddressData,
        lifetime: Arc<RequestLifetime>,
    ) -> Result<Arc<NativeJob>> {
        self.start(Purpose::Socket(address), lifetime)
    }
    pub(super) fn telemetry(
        &self,
        collector: Arc<crate::command_telemetry::CommandTelemetry>,
        session: reverie_core::ids::ProfileSessionId,
        body: Vec<u8>,
        lifetime: Arc<RequestLifetime>,
    ) -> Result<Arc<NativeJob>> {
        self.start(
            Purpose::Telemetry {
                collector,
                session,
                body,
            },
            lifetime,
        )
    }
    fn start(&self, purpose: Purpose, lifetime: Arc<RequestLifetime>) -> Result<Arc<NativeJob>> {
        let mut state = self.0.lock().map_err(|_| OfficeError::Unconfirmed)?;
        if state.closed {
            return Err(OfficeError::Closed);
        }
        state.jobs.retain(|job| !job.known_settled());
        // Original32 request seats plus one shared backend lookup. Retained
        // jobs keep their actual seats; this is no caller-selected budget.
        if state.jobs.len() >= 33 {
            return Err(OfficeError::Refused);
        }
        let job = NativeJob::new(lifetime);
        state.jobs.push(job.clone());
        drop(state);
        job.start(purpose)?;
        Ok(job)
    }
    pub(super) fn close(&self, end: Instant) -> Result<()> {
        let jobs = {
            let mut state = super::lock_until(&self.0, end)?;
            state.closed = true;
            state.jobs.clone()
        };
        let mut result = Ok(());
        for job in &jobs {
            result = super::finalized(result, job.close(end));
        }
        let mut state = super::lock_until(&self.0, end)?;
        state.jobs.retain(|job| !job.known_settled());
        result
    }
    pub(super) fn known_settled(&self) -> bool {
        self.0
            .try_lock()
            .is_ok_and(|state| state.jobs.iter().all(|job| job.known_settled()))
    }
}
