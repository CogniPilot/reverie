use super::{
    CommandTelemetry,
    error::{Result, finalized},
    records::clock,
};
use reverie_contracts::command_telemetry::TelemetryDataError;
pub use reverie_core::command_telemetry::EmployeeFailureReport as EmployeeReport;
use reverie_core::ids::ProfileEmployeeId;
use std::{fs, os::unix::fs::MetadataExt};
impl CommandTelemetry {
    fn employee_binding(
        &self,
        employee: &ProfileEmployeeId,
    ) -> Result<Option<reverie_contracts::storage_identity::MetadataText>> {
        let records = reverie_store::storage_identity::company_records(&self.identity()?)?;
        let mut selected = records
            .records()
            .iter()
            .filter(|row| row.identity().scalar_text().as_deref() == Some(employee.as_str()));
        let row = selected.next().ok_or(TelemetryDataError::Binding)?;
        if selected.next().is_some() {
            return Err(TelemetryDataError::Binding.into());
        }
        Ok(row.owner().clone())
    }
    fn employee_report(&self, employee: &ProfileEmployeeId) -> Result<EmployeeReport> {
        let expected = self.employee_binding(employee)?;
        if self.employee_binding(employee)? != expected {
            return Err(TelemetryDataError::Binding.into());
        }
        let root = crate::native::python_path(&self.sink()?.codepoints())?;
        crate::worker_storage::telemetry_directory(&root, self.uid, false)?;
        let directory = root.join(employee.as_str());
        match fs::symlink_metadata(&directory) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if self.employee_binding(employee)? != expected {
                    return Err(TelemetryDataError::Binding.into());
                }
                return Ok(EmployeeReport::NoData);
            }
            Err(e) => return Err(e.into()),
            Ok(_) => {}
        }
        crate::worker_storage::telemetry_directory(&directory, self.uid, false)?;
        crate::worker_storage::telemetry_directory(&directory.join("hands"), self.uid, false)?;
        self.precheck_report(&directory.join("hands/command-failures.sqlite"))?;
        #[cfg(test)]
        super::tests::hit(super::tests::Point::ReportPrechecked);
        let log = self.existing_log(employee)?;
        let report = log.report(clock()?)?;
        #[cfg(test)]
        super::tests::hit(super::tests::Point::ReportRead);
        if self.employee_binding(employee)? != expected {
            return Err(TelemetryDataError::Binding.into());
        }
        crate::worker_storage::telemetry_directory(&root, self.uid, false)?;
        Ok(EmployeeReport::Ready(report))
    }
    fn precheck_report(&self, path: &std::path::Path) -> Result<()> {
        let file = crate::native::open_at(
            libc::AT_FDCWD,
            path.as_os_str(),
            libc::O_RDONLY | libc::O_NONBLOCK,
        )?;
        let result = (|| {
            let info = file.metadata()?;
            if info.is_file()
                && info.uid() == self.uid
                && info.nlink() == 1
                && info.mode() & 0o7777 == 0o600
            {
                Ok(())
            } else {
                Err(TelemetryDataError::Boundary.into())
            }
        })();
        finalized(result, crate::native::close(file).map_err(Into::into))
    }
    /// Protected host audience, including stopped/retired employees. Caller
    /// owner authorization remains separate. Missing DB is unavailable, never
    /// initialized as a successful empty report; missing employee dir is no_data.
    pub fn report_employee(&self, employee: &ProfileEmployeeId) -> EmployeeReport {
        if !self.enabled() {
            return EmployeeReport::Unavailable;
        }
        let Ok(_held) = self.reports.lock() else {
            return EmployeeReport::Unavailable;
        };
        self.quiet(self.employee_report(employee))
            .unwrap_or(EmployeeReport::Unavailable)
    }
}

impl CommandTelemetry {
    /// The protected T reader owns authorization. Busy refuses before storage;
    /// this service does not queue another batch or take the producer mutex.
    pub fn command_failure_report(
        &self,
        request: &reverie_core::command_telemetry::FailureReportRequest,
    ) -> Result<Vec<u8>> {
        let _held = self
            .reports
            .try_lock()
            .map_err(|_| TelemetryDataError::Report)?;
        let reports = request
            .employees()
            .iter()
            .map(|employee| {
                if !self.enabled() {
                    return EmployeeReport::Unavailable;
                }
                self.quiet(self.employee_report(employee))
                    .unwrap_or(EmployeeReport::Unavailable)
            })
            .collect::<Vec<_>>();
        Ok(reverie_contracts::command_telemetry::build_report(
            &self.policy,
            request,
            &reports,
        )?)
    }
}
