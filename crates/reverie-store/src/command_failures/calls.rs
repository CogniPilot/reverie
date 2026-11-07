use super::{
    FailureLog, FailureStoreError,
    error::{Result, need},
};
use reverie_core::{
    command_telemetry::{FailureEvent, FailureReport},
    ids::ProfileEmployeeId,
    worker_options::TelemetryKey,
};
use std::{path::Path, sync::Mutex};
#[derive(Default)]
struct State {
    active: usize,
    retained: Vec<FailureStoreError>,
}
/// Actual collector-owned DB-call lifetime. Two slots come from the original
/// independent producer/report locks, not a caller-selected concurrency policy.
/// Uncertain native closes remain here and fence subsequent opens. A false
/// pending observation is a snapshot, never a global service shutdown ACK.
#[derive(Default)]
pub struct LearningLogs {
    state: Mutex<State>,
}
impl LearningLogs {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn open<'a>(
        &'a self,
        directory: &Path,
        employee: &ProfileEmployeeId,
        keys: &[TelemetryKey],
        uid: u32,
    ) -> Result<LearningLogCall<'a>> {
        self.open_purpose(
            directory,
            employee,
            keys,
            uid,
            super::OpenPurpose::CreateHands,
        )
    }
    /// Protected reporting never creates a missing directory or database.
    /// Existing-file source schema/expiry maintenance remains unchanged.
    pub fn open_existing<'a>(
        &'a self,
        directory: &Path,
        employee: &ProfileEmployeeId,
        keys: &[TelemetryKey],
        uid: u32,
    ) -> Result<LearningLogCall<'a>> {
        self.open_purpose(
            directory,
            employee,
            keys,
            uid,
            super::OpenPurpose::ExistingHands,
        )
    }
    fn open_purpose<'a>(
        &'a self,
        directory: &Path,
        employee: &ProfileEmployeeId,
        keys: &[TelemetryKey],
        uid: u32,
        purpose: super::OpenPurpose,
    ) -> Result<LearningLogCall<'a>> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| FailureStoreError::Unconfirmed)?;
            need(state.retained.is_empty() && state.active < 2)?;
            state.active += 1;
        }
        let permit = Permit(self);
        let log = self.capture(FailureLog::open(directory, employee, keys, uid, purpose))?;
        Ok(LearningLogCall { log, permit })
    }
    fn capture<T>(&self, result: Result<T>) -> Result<T> {
        match result {
            Err(error) if error.is_uncertain() => {
                // Publish retention BEFORE an admission can be decremented or
                // a caller can discard its outward generic error.
                match self.state.lock() {
                    Ok(mut state) => state.retained.push(error),
                    Err(state) => state.into_inner().retained.push(error),
                }
                Err(FailureStoreError::Unconfirmed)
            }
            other => other,
        }
    }
    pub fn has_unconfirmed(&self) -> bool {
        self.state
            .lock()
            .map_or(true, |state| !state.retained.is_empty())
    }
    pub fn has_pending(&self) -> bool {
        self.state.lock().map_or(true, |state| {
            state.active != 0 || !state.retained.is_empty()
        })
    }
    fn clear(&self) -> Result<()> {
        let state = self
            .state
            .lock()
            .map_err(|_| FailureStoreError::Unconfirmed)?;
        need(state.retained.is_empty())
    }
}
struct Permit<'a>(&'a LearningLogs);
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active = state
            .active
            .checked_sub(1)
            .expect("one admitted telemetry call");
    }
}
/// Actual admission, with a bound directory/database identity and no raw SQL or
/// callback accessor. Dropping it changes bookkeeping only; every native close
/// has already been checked and any uncertainty is owned by LearningLogs.
pub struct LearningLogCall<'a> {
    log: FailureLog,
    permit: Permit<'a>,
}
impl LearningLogCall<'_> {
    pub fn observe(&self, event: &FailureEvent, now: u64) -> Result<bool> {
        self.permit.0.clear()?;
        self.permit.0.capture(self.log.observe(event, now))
    }
    pub fn report(&self, now: u64) -> Result<FailureReport> {
        self.permit.0.clear()?;
        self.permit.0.capture(self.log.report(now))
    }
}
#[cfg(test)]
mod tests;
