use super::*;
use reverie_contracts::worker_config::WorkerPolicyDigest;
impl ExactStopAttempt {
    /// Real inspect and early header validation. The App's existing effective
    /// config/policy resolver runs AFTER this method, before strict state/PID.
    pub(super) fn inspect(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        self.bound(runtime)?;
        need(
            self.phase == Phase::Held,
            "RESOURCE_SOURCE_STOP_ALREADY_ATTEMPTED",
        )?;
        self.phase = Phase::Inspecting;
        let result = (|| {
            let output = self.call(
                vec!["inspect".into(), self.name.name().as_str().into()],
                true,
            )?;
            self.inspection = Some(
                SourceStopInspection::identity_for_worker(
                    &output.stdout,
                    self.name.name(),
                    self.name.session(),
                    self.name.container(),
                    runtime.worker_identity().deployment(),
                )
                .map_err(SourceStopError::Data)?,
            );
            Ok(())
        })();
        self.finish(result, Phase::Policy)
    }
    /// A late policy observation failure is terminal too; it never permits a
    /// second inspect/resolver/stop attempt from this actual source record.
    pub(super) fn refuse_policy(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        self.bound(runtime)?;
        need(
            self.phase == Phase::Policy,
            "RESOURCE_SOURCE_STOP_ALREADY_ATTEMPTED",
        )?;
        self.phase = Phase::Failed;
        self.failure = Some(Arc::new(SourceStopError::Refused(
            "RESOURCE_SOURCE_STOP_POLICY_UNAVAILABLE",
        )));
        Ok(())
    }
    pub(super) fn stop_after_policy(
        &mut self,
        runtime: &WorkerRuntime,
        policy: &WorkerPolicyDigest,
    ) -> Result<()> {
        self.bound(runtime)?;
        need(
            self.phase == Phase::Policy,
            "RESOURCE_SOURCE_STOP_ALREADY_ATTEMPTED",
        )?;
        self.phase = Phase::Stopping;
        let result = self.stop_body(policy);
        self.finish(result, Phase::Stopped)
    }
    fn stop_body(&mut self, policy: &WorkerPolicyDigest) -> Result<()> {
        let row = self.inspection.as_ref().expect("actual inspected source");
        row.assert_policy(policy).map_err(SourceStopError::Data)?;
        let state = row.state().map_err(SourceStopError::Data)?;
        need(
            state.pid() == &self.name.pid()?,
            "Exact source process incarnation changed",
        )?;
        self.process_matches()?;
        // These are intentionally DISTINCT fixed /proc reads. Python performs
        // expected_process validation, then captures original_start anew.
        let start = self.process_matches()?;
        self.original_start = Some(start);
        self.metadata = Some(row.metadata());
        if state.running() {
            self.call(
                vec![
                    "stop".into(),
                    "--time".into(),
                    "2".into(),
                    self.name.container().as_str().into(),
                ],
                false,
            )?;
            let released = self.observe(false)?;
            if released.running() {
                need(
                    released.pid() == state.pid(),
                    "Exact source process incarnation changed before kill",
                )?;
                let start = self.observed_process_start()?;
                need(
                    Some(&start) == self.original_start.as_ref(),
                    "Exact source process incarnation changed before kill",
                )?;
                self.call(
                    vec!["kill".into(), self.name.container().as_str().into()],
                    true,
                )?;
                let after = self.observe(true)?;
                need(
                    !after.running() && after.pid().is_zero(),
                    "Exact source laptop release is unconfirmed",
                )?;
            } else {
                need(
                    released.pid().is_zero(),
                    "Exact source laptop release is unconfirmed",
                )?;
            }
        }
        Ok(())
    }
    fn process_matches(&self) -> Result<String> {
        let start = self.observed_process_start()?;
        need(
            self.name.start_matches(&start)?,
            "Exact source process incarnation changed",
        )?;
        Ok(start)
    }
    fn observed_process_start(&self) -> Result<String> {
        self.name.process_start(self.read_end())
    }
    fn observe(
        &mut self,
        required: bool,
    ) -> Result<reverie_contracts::worker_source_stop::SourceStopState> {
        let output = self.call(
            vec!["inspect".into(), self.name.container().as_str().into()],
            required,
        )?;
        self.metadata
            .as_ref()
            .expect("captured original metadata")
            .observe(&output.stdout, output.succeeded)
            .map_err(SourceStopError::Data)
    }
}
