use super::*;
use reverie_contracts::worker_source_stop::{OrdinaryContainer, ordinary_container_absent};
impl OrdinaryStopAttempt {
    pub(super) fn stop_container(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        let before = self.call(vec!["inspect".into(), self.name.clone().into()], false)?;
        if !before.succeeded {
            return self.require_container_absent();
        }
        let before = self.decode_container(runtime, &before.stdout)?;
        if let Some(expected) = &self.container {
            need(
                expected == before.id(),
                "WORKER_ORDINARY_STOP_IDENTITY_CHANGED",
            )?;
        }
        self.container = Some(before.id().clone());
        let cid = before.id().as_str();
        // Preserve the legacy optional stop even when the first observation is
        // already stopped. Address the captured ID rather than recycled names.
        self.call(
            vec!["stop".into(), "--time".into(), "2".into(), cid.into()],
            false,
        )?;
        let state = self.observe_container(runtime, false)?;
        if state.as_ref().is_some_and(OrdinaryContainer::running) {
            self.call(vec!["kill".into(), cid.into()], true)?;
            let state = self.observe_container(runtime, true)?;
            need(
                state.is_some_and(|state| state.stopped()),
                "Laptop did not stop",
            )?;
        } else {
            need(
                state.is_none_or(|state| state.stopped()),
                "WORKER_ORDINARY_STOP_STATE_UNAVAILABLE",
            )?;
        }
        Ok(())
    }
    fn decode_container(&self, runtime: &WorkerRuntime, raw: &[u8]) -> Result<OrdinaryContainer> {
        OrdinaryContainer::decode(
            raw,
            &self.name,
            runtime.worker_identity().deployment(),
            &self.session,
        )
        .map_err(SourceStopError::Data)
    }
    fn observe_container(
        &mut self,
        runtime: &WorkerRuntime,
        required: bool,
    ) -> Result<Option<OrdinaryContainer>> {
        let id = self
            .container
            .as_ref()
            .expect("actual captured immutable container")
            .clone();
        let output = self.call(vec!["inspect".into(), id.as_str().into()], required)?;
        if !output.succeeded {
            self.require_container_absent()?;
            return Ok(None);
        }
        let state = self.decode_container(runtime, &output.stdout)?;
        need(state.id() == &id, "WORKER_ORDINARY_STOP_IDENTITY_CHANGED")?;
        Ok(Some(state))
    }
    fn require_container_absent(&mut self) -> Result<()> {
        let output = self.call(
            vec![
                "ps".into(),
                "--all".into(),
                "--no-trunc".into(),
                "--format".into(),
                "{{.ID}} {{.Names}}".into(),
            ],
            true,
        )?;
        let absent = ordinary_container_absent(&output.stdout, &self.name, self.container.as_ref())
            .map_err(SourceStopError::Data)?;
        need(absent, "WORKER_ORDINARY_STOP_STATE_UNAVAILABLE")
    }
}
