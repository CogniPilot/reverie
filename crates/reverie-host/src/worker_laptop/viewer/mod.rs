//! Owned fixed PTY attach after real pane and original Nix guard finalization.
//! The application must still perform actual admission/canonical release first.
//! Existing reuse uses its original storage/inspection record rather than a
//! created-pane token. Actual App admission/release remains a separate join.
pub(super) mod cleanup;
mod job;
pub(in crate::worker_laptop) mod receipt;
mod terminal;
#[cfg(test)]
pub(super) mod test_hooks;
use super::call_budget::CallBudget;
use super::*;
pub(crate) use job::Job as ViewerJob;
use reverie_core::worker_launch::{ContainerReference, TerminalSize};
enum SessionOrigin {
    Created(LaptopWorkflow),
    Existing(existing_viewer::ExistingReference),
}

#[must_use = "retain the actual viewer until checked session and PTY cleanup"]
pub struct ViewerSession {
    origin: SessionOrigin,
    job: Arc<job::Job>,
}
impl ViewerSession {
    #[cfg(test)]
    pub(in crate::worker_laptop) fn native_status_for_owned_test(&self) -> Result<Option<i32>> {
        self.job.status()
    }
    #[cfg(test)]
    pub(in crate::worker_laptop) fn native_counts_for_owned_test(&self) -> (usize, usize) {
        self.job.native_counts()
    }
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        matches!(&self.origin,SessionOrigin::Created(workflow) if workflow.same_workflow(other))
    }
    pub fn same_existing(&self, other: &ExistingViewer) -> bool {
        matches!(&self.origin,SessionOrigin::Existing(existing) if existing.same_owner(&other.reference))
    }
    pub(super) fn existing(
        reference: existing_viewer::ExistingReference,
        job: Arc<ViewerJob>,
    ) -> Self {
        Self {
            origin: SessionOrigin::Existing(reference),
            job,
        }
    }
    pub fn failure(&self) -> Result<Option<Arc<LaptopError>>> {
        self.job.failure()
    }
}
#[must_use = "a pending constructor remains owned by the original laptop record"]
pub enum ViewerStart {
    Started(ViewerSession),
    Retained,
}
impl Workflows {
    fn start_viewer(
        &self,
        runtime: &WorkerRuntime,
        pane: &NixReleasedPane,
        end: CallBudget,
    ) -> Result<ViewerStart> {
        self.bound(runtime, &pane.workflow)?;
        let mut record = pane
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::Known
                && !record.unknown
                && record.pending.is_none()
                && record.viewer.is_none()
                && record.outcome.as_ref().is_some_and(|r| r.is_ok())
                && record.creation.as_ref().is_some_and(|c| {
                    c.stage == create::CreateStage::NixGuardReleased
                        && c.publication
                            .as_ref()
                            .is_some_and(publication::Publication::confirmed)
                }),
            "WORKER_VIEWER_PHASE",
        )?;
        need(
            !runtime.cancellation().is_cancelled() && end.check(runtime).is_ok(),
            "WORKER_VIEWER_STOPPED",
        )?;
        let mut marker = [0u8; 16];
        getrandom::getrandom(&mut marker)
            .map_err(|error| LaptopError::Io(std::io::Error::other(error.to_string())))?;
        let resources = record.resources();
        let size = resources.request.terminal();
        let job = job::Job::new(
            runtime,
            resources.plan.arguments().worker_name().clone(),
            size,
            marker,
            resources.connection.clone(),
        );
        // Real constructor ownership is installed BEFORE thread creation/open/
        // spawn. Same bounded record is inventoried even if this caller times out.
        record.viewer = Some(job.clone());
        record.creation.as_mut().expect("actual pane").stage = create::CreateStage::StartingViewer;
        match launch_constructor(runtime, &job, end) {
            Ok(()) => {
                record.creation.as_mut().expect("actual viewer").stage =
                    create::CreateStage::Viewing;
                Ok(ViewerStart::Started(ViewerSession {
                    origin: SessionOrigin::Created(pane.workflow.clone()),
                    job,
                }))
            }
            Err(error) => {
                record.unknown = true;
                record.phase = Phase::Retained;
                record.outcome = Some(Err(error));
                Ok(ViewerStart::Retained)
            }
        }
    }
    fn viewer<'a>(
        &self,
        runtime: &WorkerRuntime,
        viewer: &'a ViewerSession,
        forward: bool,
    ) -> Result<ViewerGuard<'a>> {
        self.viewer_cleanup(runtime, viewer, forward, None)
    }
    fn viewer_cleanup<'a>(
        &self,
        runtime: &WorkerRuntime,
        viewer: &'a ViewerSession,
        forward: bool,
        cleanup: Option<cleanup::Cleanup>,
    ) -> Result<ViewerGuard<'a>> {
        let guard = match &viewer.origin {
            SessionOrigin::Created(workflow) => {
                self.bound(runtime, workflow)?;
                ViewerGuard::Created(cleanup::acquire(
                    runtime,
                    &workflow.record,
                    cleanup,
                    "WORKER_LAPTOP_RETAINED",
                )?)
            }
            SessionOrigin::Existing(existing) => {
                self.bound_existing(runtime, existing)?;
                ViewerGuard::Existing(cleanup::acquire(
                    runtime,
                    &existing.record,
                    cleanup,
                    "WORKER_EXISTING_VIEWER_RETAINED",
                )?)
            }
        };
        if forward {
            need(
                !runtime.cancellation().is_cancelled(),
                "WORKER_VIEWER_PHASE",
            )?;
        }
        guard.assert_session(&viewer.job, forward)?;
        Ok(guard)
    }
}
enum ViewerGuard<'a> {
    Created(std::sync::MutexGuard<'a, Record>),
    Existing(std::sync::MutexGuard<'a, existing_viewer::ExistingRecord>),
}
impl ViewerGuard<'_> {
    fn assert_session(&self, job: &Arc<ViewerJob>, forward: bool) -> Result<()> {
        match self {
            Self::Created(record) => {
                need(
                    record
                        .viewer
                        .as_ref()
                        .is_some_and(|current| Arc::ptr_eq(current, job)),
                    "WORKER_VIEWER_ORIGIN",
                )?;
                if forward {
                    need(
                        record.phase == Phase::Known
                            && record
                                .creation
                                .as_ref()
                                .is_some_and(|c| c.stage == create::CreateStage::Viewing),
                        "WORKER_VIEWER_PHASE",
                    )?;
                }
                Ok(())
            }
            Self::Existing(record) => record.assert_session(job, forward),
        }
    }
}
pub(super) fn launch_constructor(
    runtime: &WorkerRuntime,
    job: &Arc<ViewerJob>,
    end: CallBudget,
) -> std::result::Result<(), Arc<LaptopError>> {
    if let Err(error) = admit_constructor(runtime, job, end) {
        let error = Arc::new(error);
        job.refused_before_admission(error.clone());
        return Err(error);
    }
    job.launch(runtime.cancellation());
    match job.wait_started(runtime, end).map_err(Arc::new)? {
        true => {
            let client = &runtime.installed_engine().engine.client;
            match end.ceiling() {
                Some(end) => client.handoff_viewer(job, end),
                None => client.handoff_viewer_for_worker(job),
            }
            .map_err(|error| Arc::new(LaptopError::Engine(error.into())))
        }
        false => Err(job
            .failure()
            .map_err(Arc::new)?
            .unwrap_or_else(|| Arc::new(LaptopError::Refused("VIEWER_CONSTRUCTOR_UNCONFIRMED")))),
    }
}
fn admit_constructor(
    runtime: &WorkerRuntime,
    job: &Arc<ViewerJob>,
    ceiling: CallBudget,
) -> Result<()> {
    loop {
        need(
            !runtime.cancellation().is_cancelled() && ceiling.check(runtime).is_ok(),
            "VIEWER_START_PENDING",
        )?;
        match runtime.installed_engine().engine.client.admit_viewer(job) {
            Ok(()) => return Ok(()),
            Err(error)
                if error.fault == crate::captured_client::Fault::Busy
                    && !error.may_have_started =>
            {
                #[cfg(test)]
                test_hooks::admission_busy();
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(error) => return Err(LaptopError::Engine(error.into())),
        }
    }
}
impl WorkerRuntime {
    /// Lower fixed Host constructor; the actual App continuation must call only
    /// after protected CLI/admission/canonical release in original source order.
    /// This does not construct an App release proof or a wire dispatch endpoint.
    pub fn start_laptop_viewer_session(
        &self,
        pane: &NixReleasedPane,
        end: Instant,
    ) -> Result<ViewerStart> {
        self.laptop_workflows()
            .start_viewer(self, pane, CallBudget::bounded(end))
    }
    pub fn start_laptop_viewer_session_for_worker(
        &self,
        pane: &NixReleasedPane,
        connection: &crate::worker_reports::WorkerLaunchConnection,
    ) -> Result<ViewerStart> {
        self.laptop_workflows()
            .assert_worker_connection(self, &pane.workflow, connection)?;
        self.laptop_workflows()
            .start_viewer(self, pane, CallBudget::worker())
    }
    pub fn read_laptop_viewer(&self, viewer: &ViewerSession, bytes: &mut [u8]) -> Result<usize> {
        let _record = self.laptop_workflows().viewer(self, viewer, true)?;
        viewer.job.read(bytes)
    }
    pub fn write_laptop_viewer(&self, viewer: &ViewerSession, bytes: &[u8]) -> Result<usize> {
        let _record = self.laptop_workflows().viewer(self, viewer, true)?;
        viewer.job.write(bytes)
    }
    /// Local PTY ioctl and exact attach-client SIGWINCH only. Guest list-client
    /// marker/dimension confirmation remains a separate required transport phase.
    pub fn resize_laptop_viewer_pty(
        &self,
        viewer: &ViewerSession,
        size: TerminalSize,
    ) -> Result<()> {
        let _record = self.laptop_workflows().viewer(self, viewer, true)?;
        viewer.job.resize(size)
    }
    /// Python Popen status: normal code or NEGATIVE terminating signal. Observing
    /// exit is WNOWAIT and never releases the group pin or laptop/storage owners.
    pub fn laptop_viewer_status(&self, viewer: &ViewerSession) -> Result<Option<i32>> {
        let _record = self.laptop_workflows().viewer(self, viewer, true)?;
        viewer.job.status()
    }
    pub fn close_laptop_viewer(&self, viewer: &ViewerSession, end: Instant) -> Result<()> {
        let _record = self.laptop_workflows().viewer(self, viewer, false)?;
        viewer.job.close(self, end)
    }
    pub fn close_laptop_viewer_for_worker(&self, viewer: &ViewerSession) -> Result<()> {
        let cleanup = cleanup::Cleanup::worker(self);
        let _record = self
            .laptop_workflows()
            .viewer_cleanup(self, viewer, false, Some(cleanup))?;
        viewer.job.close_for_worker(self, cleanup.guard())
    }
}
