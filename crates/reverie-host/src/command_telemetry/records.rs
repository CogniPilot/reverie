use super::{CommandTelemetry, TelemetryError, error::Result};
use reverie_contracts::{
    command_telemetry::{self, TelemetryDataError},
    storage_identity::MetadataText,
};
use reverie_core::{
    command_telemetry::FailureReport,
    ids::{ProfileEmployeeId, ProfileSessionId},
};
use reverie_store::{
    command_failures::LearningLogCall,
    storage_identity::{self, StorageIdentityConfig, StorageKind},
};
use std::time::{SystemTime, UNIX_EPOCH};
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Binding {
    employee: ProfileEmployeeId,
    owner: Option<MetadataText>,
}
impl CommandTelemetry {
    pub(super) fn identity(&self) -> Result<StorageIdentityConfig> {
        Ok(StorageIdentityConfig::capture_worker_settings(
            &command_telemetry::TelemetrySource::capture(&self.config)
                .identity_settings(self.uid)?,
        ))
    }
    fn binding(&self, session: &ProfileSessionId) -> Result<Binding> {
        let identity = self.identity()?;
        let records = storage_identity::company_records(&identity)?;
        let row = records
            .by_session(session)
            .ok_or(TelemetryDataError::Binding)?;
        let employee = row
            .canonical_identity()
            .map_err(|_| TelemetryDataError::Binding)?;
        let paths = storage_identity::storage_paths(&identity, session)?;
        if paths.kind() != StorageKind::Employee
            || paths.identity() != employee.as_str()
            || paths.owner() != row.owner()
            || !storage_identity::storage_start_allowed(&identity, &paths)?
        {
            return Err(TelemetryDataError::Binding.into());
        }
        Ok(Binding {
            employee,
            owner: paths.owner().clone(),
        })
    }
    fn log_directory(&self, employee: &ProfileEmployeeId) -> Result<std::path::PathBuf> {
        if self.logs.has_unconfirmed() {
            return Err(TelemetryError::Runtime);
        }
        Ok(crate::native::python_path(&self.sink()?.codepoints())?.join(employee.as_str()))
    }
    pub(super) fn log(&self, employee: &ProfileEmployeeId) -> Result<LearningLogCall<'_>> {
        let directory = self.log_directory(employee)?;
        crate::worker_storage::telemetry_directory(&directory, self.uid, true)?;
        Ok(self
            .logs
            .open(&directory.join("hands"), employee, self.keys(), self.uid)?)
    }
    pub(super) fn existing_log(&self, employee: &ProfileEmployeeId) -> Result<LearningLogCall<'_>> {
        let directory = self.log_directory(employee)?;
        Ok(self
            .logs
            .open_existing(&directory.join("hands"), employee, self.keys(), self.uid)?)
    }
    fn observe_event(&self, session: &ProfileSessionId, raw: &[u8]) -> Result<bool> {
        let event = command_telemetry::decode_event(raw, self.keys())?;
        let binding = self.binding(session)?;
        #[cfg(test)]
        super::tests::hit(super::tests::Point::FirstBinding);
        let _held = self.producer.lock().map_err(|_| TelemetryError::Runtime)?;
        if self.binding(session)? != binding {
            return Ok(false);
        }
        let result = (|| {
            let log = self.log(&binding.employee)?;
            #[cfg(test)]
            super::tests::hit(super::tests::Point::LogOpened);
            if self.binding(session)? != binding {
                return Ok(false);
            }
            Ok(log.observe(&event, clock()?)?)
        })();
        Ok(self.quiet(result).unwrap_or(false))
    }
    /// Authenticated Office's constructor-selected session only. The event has
    /// no employee, path, harness, time or effect capability. Never echo errors.
    pub fn observe(&self, session: &ProfileSessionId, raw: &[u8]) -> bool {
        if !self.enabled() {
            return false;
        }
        self.quiet(self.observe_event(session, raw))
            .unwrap_or(false)
    }
    /// Existing host-only reader; no new HTTP audience or browser authority.
    pub fn report(&self, session: &ProfileSessionId) -> Option<FailureReport> {
        if !self.enabled() {
            return None;
        }
        let binding = self.binding(session).ok()?;
        let _held = self.producer.lock().ok()?;
        let result = (|| {
            if self.binding(session)? != binding {
                return Err(TelemetryDataError::Binding.into());
            }
            let log = self.log(&binding.employee)?;
            if self.binding(session)? != binding {
                return Err(TelemetryDataError::Binding.into());
            }
            Ok(log.report(clock()?)?)
        })();
        self.quiet(result)
    }

    pub(super) fn quiet<T>(&self, result: Result<T>) -> Option<T> {
        result.ok()
    }
    /// Not a cleanup ACK: actual refused-close Connections remain Store-owned.
    /// In-flight log operations or retained uncertainty; an observation alone
    /// is not an admission fence or permission for global shutdown/release.
    pub fn has_pending_store(&self) -> bool {
        self.logs.has_pending()
    }
    pub fn has_unconfirmed_store(&self) -> bool {
        self.logs.has_unconfirmed()
    }
}
pub(super) fn clock() -> Result<u64> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| TelemetryDataError::Event)?
        .as_secs();
    if now > reverie_core::command_telemetry::FAILURE_CLOCK_MAX {
        return Err(TelemetryDataError::Event.into());
    }
    Ok(now)
}
