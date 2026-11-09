//! Owner-local offline PERF-only transition. No employee start, stop, image
//! change or shared-pool activation is performed by this operation.
use super::worker_image::{OfflineImageSwitchError, broker_close::UnstartedImageBroker};
use super::*;
use crate::reservation_gate::{PerfAdmission, PerfPreview};
use reverie_core::{
    ids::ProfileEmployeeId,
    operations::{JournalDigest, JournalId},
    task_perf::TaskPerfPolicy,
};
use reverie_host::{
    gpu_access::{PerfControlFiles, PerfPending, PerfTerminal},
    worker_image::{ClosedImageMaintenance, ImageMaintenanceLocks},
    worker_service::{ClosedImageServiceMaintenance, ImageServiceMaintenance},
};
use std::time::Instant;
type Result<'a, T> = std::result::Result<T, OfflineImageSwitchError<'a>>;
pub struct PreparedOfflinePerfSwitch<'a> {
    owner: Option<Box<Owner<'a>>>,
}
pub struct OfflinePerfFailure<'a> {
    owner: Option<Box<Owner<'a>>>,
    cause: OfflineImageSwitchError<'a>,
    cleanup: Vec<OfflineImageSwitchError<'a>>,
    attempted: bool,
}
struct Owner<'a> {
    broker: &'a InstallingBroker,
    broker_close: UnstartedImageBroker<'a>,
    files: Option<PerfControlFiles>,
    preview: Option<PerfPreview>,
    admission: Option<PerfAdmission<'a>>,
    service: Option<ImageServiceMaintenance>,
    closed_service: Option<ClosedImageServiceMaintenance>,
    locks: Option<ImageMaintenanceLocks>,
    closed_locks: Option<ClosedImageMaintenance>,
    pending: Option<PerfPending>,
    terminal: Option<PerfTerminal>,
    end: Instant,
}
pub struct OfflinePerfClosed {
    configuration: JournalDigest,
    preview: JournalDigest,
}
impl OfflinePerfClosed {
    pub fn configuration_digest(&self) -> &JournalDigest {
        &self.configuration
    }
    pub fn preview_digest(&self) -> &JournalDigest {
        &self.preview
    }
}
impl InstallingBroker {
    pub fn prepare_offline_perf_switch(
        &self,
        employee: ProfileEmployeeId,
        policy: Option<TaskPerfPolicy>,
        end: Instant,
    ) -> std::result::Result<PreparedOfflinePerfSwitch<'_>, Box<OfflinePerfFailure<'_>>> {
        let mut owner = Box::new(Owner {
            broker: self,
            broker_close: UnstartedImageBroker::new(self),
            files: None,
            preview: None,
            admission: None,
            service: None,
            closed_service: None,
            locks: None,
            closed_locks: None,
            pending: None,
            terminal: None,
            end,
        });
        match owner.prepare(employee, policy) {
            Ok(()) => Ok(PreparedOfflinePerfSwitch { owner: Some(owner) }),
            Err(cause) => Err(OfflinePerfFailure::new(owner, cause)),
        }
    }
}
impl<'a> Owner<'a> {
    fn gate(&self) -> Result<'a, &'a ReservationGate> {
        self.broker
            .resource_reservations()
            .map_err(OfflineImageSwitchError::gate)?
            .ok_or_else(|| OfflineImageSwitchError::refused("PERF_EXISTING_DOMAIN_REQUIRED"))
    }
    fn prepare(
        &mut self,
        employee: ProfileEmployeeId,
        policy: Option<TaskPerfPolicy>,
    ) -> Result<'a, ()> {
        self.broker_close.claim()?;
        let before = self
            .broker
            .installed
            .snapshot()
            .map_err(OfflineImageSwitchError::gate)?;
        let source = before
            .source_path()
            .ok_or_else(|| OfflineImageSwitchError::refused("PERF_REGISTERED_SOURCE_REQUIRED"))?;
        self.files = Some(PerfControlFiles::capture(source, before.configuration()));
        self.locks = Some(
            ImageMaintenanceLocks::capture(source, before.configuration(), self.end)
                .map_err(OfflineImageSwitchError::maintenance)?,
        );
        self.preview = Some(
            self.gate()?
                .preview_offline_perf(
                    self.files.as_mut().expect("original PERF files"),
                    employee,
                    policy,
                    self.end,
                )
                .map_err(OfflineImageSwitchError::gate)?,
        );
        self.close_locks()?;
        Ok(())
    }
    fn assert_current(&mut self, end: Instant) -> Result<'a, ()> {
        let admission = self
            .gate()?
            .enter_offline_perf(
                self.preview.as_ref().expect("original PERF preview"),
                self.files.as_mut().expect("original PERF files"),
                end.min(self.end),
            )
            .map_err(OfflineImageSwitchError::gate)?;
        self.admission = Some(admission);
        self.close_admission()
    }
    fn close_admission(&mut self) -> Result<'a, ()> {
        self.admission.as_mut().map_or(Ok(()), |owner| {
            owner.close().map_err(OfflineImageSwitchError::gate)
        })?;
        self.admission = None;
        Ok(())
    }
    fn close_locks(&mut self) -> Result<'a, ()> {
        if let Some(locks) = self.locks.take() {
            self.closed_locks = Some(
                locks
                    .close()
                    .map_err(OfflineImageSwitchError::maintenance)?,
            );
        }
        Ok(())
    }
    fn close_service(&mut self) -> Result<'a, ()> {
        if let Some(service) = self.service.take() {
            self.closed_service = Some(service.close().map_err(OfflineImageSwitchError::service)?);
        }
        Ok(())
    }
    fn run(
        &mut self,
        expected: &JournalDigest,
        operation: JournalId,
    ) -> Result<'a, OfflinePerfClosed> {
        let preview = self.preview.as_ref().expect("original PERF preview");
        require(&preview.digest == expected, "PERF_PREVIEW_CHANGED")?;
        require(
            operation.as_str() != "00000000-0000-0000-0000-000000000000",
            "PERF_OPERATION_REQUIRED",
        )?;
        let before = self
            .broker
            .installed
            .snapshot()
            .map_err(OfflineImageSwitchError::gate)?;
        let source = before
            .source_path()
            .ok_or_else(|| OfflineImageSwitchError::refused("PERF_REGISTERED_SOURCE_REQUIRED"))?;
        require(
            self.service
                .as_ref()
                .expect("original service fence")
                .source()
                == source,
            "PERF_SERVICE_SOURCE_CHANGED",
        )?;
        self.locks = Some(
            ImageMaintenanceLocks::capture(source, before.configuration(), self.end)
                .map_err(OfflineImageSwitchError::maintenance)?,
        );
        self.admission = Some(
            self.gate()?
                .enter_offline_perf(
                    preview,
                    self.files.as_mut().expect("original PERF files"),
                    self.end,
                )
                .map_err(OfflineImageSwitchError::gate)?,
        );
        self.service
            .as_mut()
            .expect("original service fence")
            .revalidate()
            .map_err(OfflineImageSwitchError::service_component)?;
        self.pending = Some(
            self.files
                .as_mut()
                .expect("original PERF files")
                .publish_pending(preview.intent.clone(), &operation, expected, self.end)
                .map_err(files_error)?,
        );
        self.terminal = Some(
            self.files
                .as_mut()
                .expect("original PERF files")
                .publish(
                    &preview.intent,
                    &preview.configuration,
                    &preview.binding,
                    self.pending.as_ref().expect("original pending"),
                    self.locks.as_mut().expect("original held locks"),
                    self.service.as_ref().expect("original service fence"),
                )
                .map_err(files_error)?,
        );
        self.admission
            .as_ref()
            .expect("original R admission")
            .assert_after(preview, self.end)
            .map_err(OfflineImageSwitchError::gate)?;
        let configuration = JournalDigest::parse(
            &reverie_contracts::worker_config::config_digest(preview.intent.after()).to_hex(),
        )
        .map_err(|e| OfflineImageSwitchError::gate(e.into()))?;
        let digest = preview.digest.clone();
        self.close_admission()?;
        self.broker_close.close(self.end)?;
        self.close_locks()?;
        self.close_service()?;
        self.closed_locks
            .as_ref()
            .expect("known original lock closure")
            .assert_current()
            .map_err(OfflineImageSwitchError::files)?;
        self.broker_close.assert_controller()?;
        let terminal = self.terminal.as_ref().expect("actual PERF terminal");
        terminal.assert_current().map_err(files_error)?;
        self.files
            .as_mut()
            .expect("original PERF files")
            .release(self.pending.as_mut().expect("original pending"), terminal)
            .map_err(files_error)?;
        let _closed = self
            .closed_service
            .take()
            .expect("known original service closure")
            .release()
            .map_err(OfflineImageSwitchError::service)?;
        Ok(OfflinePerfClosed {
            configuration,
            preview: digest,
        })
    }
    fn cleanup(&mut self, errors: &mut Vec<OfflineImageSwitchError<'a>>) {
        if let Err(e) = self.close_admission() {
            errors.push(e);
        }
        if !self.broker_close.attempted()
            && let Err(e) = self.broker_close.close(self.end)
        {
            errors.push(e);
        }
        if let Err(e) = self.close_locks() {
            errors.push(e);
        }
        if let Err(e) = self.close_service() {
            errors.push(e);
        }
    }
}
fn files_error<'a>(e: reverie_host::gpu_access::GpuHostError) -> OfflineImageSwitchError<'a> {
    OfflineImageSwitchError::gate(GateError::GpuHost(e))
}
fn require<'a>(value: bool, code: &'static str) -> Result<'a, ()> {
    if value {
        Ok(())
    } else {
        Err(OfflineImageSwitchError::refused(code))
    }
}
impl<'a> PreparedOfflinePerfSwitch<'a> {
    pub fn preview_digest(&self) -> &JournalDigest {
        &self
            .owner
            .as_ref()
            .expect("original PERF owner")
            .preview
            .as_ref()
            .expect("original preview")
            .digest
    }
    pub fn configuration_digest(&self) -> JournalDigest {
        JournalDigest::parse(
            &reverie_contracts::worker_config::config_digest(
                self.owner
                    .as_ref()
                    .expect("original PERF owner")
                    .preview
                    .as_ref()
                    .expect("original preview")
                    .intent
                    .after(),
            )
            .to_hex(),
        )
        .expect("SHA256")
    }
    pub fn employee(&self) -> &ProfileEmployeeId {
        self.owner
            .as_ref()
            .expect("original PERF owner")
            .preview
            .as_ref()
            .expect("original preview")
            .intent
            .employee()
    }
    pub fn policy(&self) -> Option<TaskPerfPolicy> {
        self.owner
            .as_ref()
            .expect("original PERF owner")
            .preview
            .as_ref()
            .expect("original preview")
            .intent
            .policy()
    }
    pub fn assert_current(
        mut self,
        end: Instant,
    ) -> std::result::Result<Self, Box<OfflinePerfFailure<'a>>> {
        let mut owner = self.owner.take().expect("original PERF owner");
        match owner.assert_current(end) {
            Ok(()) => Ok(Self { owner: Some(owner) }),
            Err(cause) => Err(OfflinePerfFailure::new(owner, cause)),
        }
    }
    pub fn close(mut self, end: Instant) -> std::result::Result<(), Box<OfflinePerfFailure<'a>>> {
        let mut owner = self.owner.take().expect("original PERF owner");
        owner.end = owner.end.min(end);
        match owner.broker_close.close(owner.end) {
            Ok(()) => Ok(()),
            Err(cause) => Err(OfflinePerfFailure::new(owner, cause)),
        }
    }
    pub fn apply(
        mut self,
        service: ImageServiceMaintenance,
        expected: &JournalDigest,
        operation: JournalId,
    ) -> std::result::Result<OfflinePerfClosed, Box<OfflinePerfFailure<'a>>> {
        let mut owner = self.owner.take().expect("original PERF owner");
        owner.end = owner.end.min(service.end());
        owner.service = Some(service);
        match owner.run(expected, operation) {
            Ok(closed) => Ok(closed),
            Err(cause) => Err(OfflinePerfFailure::new(owner, cause)),
        }
    }
}
impl<'a> OfflinePerfFailure<'a> {
    fn new(owner: Box<Owner<'a>>, cause: OfflineImageSwitchError<'a>) -> Box<Self> {
        let mut failure = Box::new(Self {
            owner: Some(owner),
            cause,
            cleanup: Vec::new(),
            attempted: false,
        });
        let _ = failure.close_components();
        failure
    }
    pub fn cause(&self) -> &OfflineImageSwitchError<'a> {
        &self.cause
    }
    pub fn cleanup_errors(&self) -> &[OfflineImageSwitchError<'a>] {
        &self.cleanup
    }
    pub fn close_components(&mut self) -> Result<'a, ()> {
        if !self.attempted {
            self.attempted = true;
            self.cause.close_components(&mut self.cleanup);
            if let Some(owner) = &mut self.owner {
                owner.cleanup(&mut self.cleanup);
            }
        }
        if self.cleanup.is_empty() {
            Ok(())
        } else {
            Err(OfflineImageSwitchError::refused(
                "PERF_FINALIZATION_RETAINED",
            ))
        }
    }
}
impl std::fmt::Debug for OfflinePerfFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OfflinePerfFailure")
            .field("cause", &self.cause)
            .field("cleanup", &self.cleanup)
            .finish()
    }
}
impl std::fmt::Display for OfflinePerfFailure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for OfflinePerfFailure<'_> {}
impl Drop for PreparedOfflinePerfSwitch<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl Drop for OfflinePerfFailure<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
