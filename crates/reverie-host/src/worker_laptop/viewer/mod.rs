//! Owned fixed PTY attach after real pane and original Nix guard finalization.
//! The application must still perform actual admission/canonical release first.
//! Recovered/reused panes have no constructor here until their real owner exists.
mod job;
#[cfg(test)]
pub(super) mod test_hooks;
use super::*;
pub(crate) use job::Job as ViewerJob;
use reverie_core::worker_launch::{ContainerReference, TerminalSize};

#[must_use = "retain the actual viewer until checked session and PTY cleanup"]
pub struct ViewerSession {
    workflow: LaptopWorkflow,
    job: Arc<job::Job>,
}
impl ViewerSession {
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(other)
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
        end: Instant,
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
            !runtime.cancellation().is_cancelled() && Instant::now() < job::clipped(runtime, end),
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
        );
        // Real constructor ownership is installed BEFORE thread creation/open/
        // spawn. Same bounded record is inventoried even if this caller times out.
        record.viewer = Some(job.clone());
        record.creation.as_mut().expect("actual pane").stage = create::CreateStage::StartingViewer;
        if let Err(error) = admit_constructor(runtime, &job, end) {
            let error = Arc::new(error);
            job.refused_before_admission(error.clone());
            record.unknown = true;
            record.phase = Phase::Retained;
            record.outcome = Some(Err(error));
            return Ok(ViewerStart::Retained);
        }
        job.launch(runtime.cancellation());
        match job.wait_started(runtime, end) {
            Ok(true) => {
                if let Err(error) = runtime
                    .installed_engine()
                    .engine
                    .client
                    .handoff_viewer(&job, end)
                {
                    record.unknown = true;
                    record.phase = Phase::Retained;
                    record.outcome = Some(Err(Arc::new(LaptopError::Engine(error.into()))));
                    return Ok(ViewerStart::Retained);
                }
                record.creation.as_mut().expect("actual viewer").stage =
                    create::CreateStage::Viewing;
                Ok(ViewerStart::Started(ViewerSession {
                    workflow: pane.workflow.clone(),
                    job,
                }))
            }
            Ok(false) => {
                record.unknown = true;
                record.phase = Phase::Retained;
                let error = job.failure()?.unwrap_or_else(|| {
                    Arc::new(LaptopError::Refused("VIEWER_CONSTRUCTOR_UNCONFIRMED"))
                });
                record.outcome = Some(Err(error));
                Ok(ViewerStart::Retained)
            }
            Err(error) => {
                record.unknown = true;
                record.phase = Phase::Retained;
                record.outcome = Some(Err(Arc::new(error)));
                Ok(ViewerStart::Retained)
            }
        }
    }
    fn viewer<'a>(
        &self,
        runtime: &WorkerRuntime,
        viewer: &'a ViewerSession,
        forward: bool,
    ) -> Result<std::sync::MutexGuard<'a, Record>> {
        self.bound(runtime, &viewer.workflow)?;
        let record = viewer
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record
                .viewer
                .as_ref()
                .is_some_and(|job| Arc::ptr_eq(job, &viewer.job)),
            "WORKER_VIEWER_ORIGIN",
        )?;
        if forward {
            need(
                record.phase == Phase::Known
                    && !runtime.cancellation().is_cancelled()
                    && record
                        .creation
                        .as_ref()
                        .is_some_and(|c| c.stage == create::CreateStage::Viewing),
                "WORKER_VIEWER_PHASE",
            )?;
        }
        Ok(record)
    }
}
fn admit_constructor(
    runtime: &WorkerRuntime,
    job: &Arc<ViewerJob>,
    ceiling: Instant,
) -> Result<()> {
    loop {
        need(
            !runtime.cancellation().is_cancelled()
                && Instant::now() < job::clipped(runtime, ceiling),
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
        self.laptop_workflows().start_viewer(self, pane, end)
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
}
