//! Snapshot historical DATA from this Runtime's existing bounded owners.
use super::*;

impl WorkerRuntime {
    /// Original completed nonzero create outputs still retained by this SAME
    /// Runtime. This is not a complete/current container census or permission
    /// to retry, settle, stop or release any resource. Empty is not absence.
    pub fn completed_create_diagnostics(&self) -> Result<Vec<Arc<LaptopCreateDiagnostic>>> {
        self.laptop_workflows().completed_create_diagnostics()
    }
}
impl Workflows {
    fn completed_create_diagnostics(&self) -> Result<Vec<Arc<LaptopCreateDiagnostic>>> {
        let records: Vec<_> = self
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?
            .iter()
            .filter_map(|record| match record {
                RetainedRecord::Created(record) => Some(record.clone()),
                _ => None,
            })
            .collect();
        let mut diagnostics = Vec::new();
        // Drop the collection lock before observing each original record.
        // Any contention refuses the snapshot; never report partial success.
        for record in records {
            let record = record
                .try_lock()
                .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
            if let Some(diagnostic) = record
                .creation
                .as_ref()
                .and_then(|creation| creation.diagnostic.as_ref())
            {
                diagnostics.push(diagnostic.clone());
            }
        }
        Ok(diagnostics)
    }
}
