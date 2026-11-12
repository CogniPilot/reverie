//! Maintained C service handoff. The actual generation denies new J before
//! selected originals are interrupted; no R is held across their physical join.
use super::*;
use reverie_host::worker_reports::{WorkerHandlersProgress, WorkerOriginalInterruptionProgress};
impl Frame<'_> {
    pub(super) fn quiesce_for_deployment(&mut self) -> Result<(), Cause> {
        self.service_drain = Some(self.broker.installed.lifecycle()?.begin_service_drain()?);
        self.handlers = Some(self.connection.retain_deployment_handlers(
            &self.broker.reports,
            &self.broker.storage.runtime,
            self.end,
        )?);
        self.close_original_handlers()?;
        let closed = self
            .closed_handlers
            .as_ref()
            .expect("actual closed originals");
        closed.assert_deployment_owner(
            &self.connection,
            &self.broker.reports,
            &self.broker.storage.runtime,
        )?;
        self.native = Some(Box::new(LegacyFleetDrain::with_service_drain(
            self.broker,
            self.end,
            self.service_drain
                .take()
                .expect("original generation denial"),
        )));
        self.native
            .as_mut()
            .expect("same actual drain")
            .run_service_stop()?;
        // Reply while the drain is still retained. A lost reply never prevents
        // the already-authorized first-stop handoff and is never retried.
        let delivery = self
            .connection
            .reply_json(br#"{"action":"quiesce-for-deployment","success":true}"#);
        let stopping = self
            .native
            .as_mut()
            .expect("same actual drain")
            .stop_service_after_drain();
        let transport = self.close_transport();
        let result = finalized(
            delivery.map_err(Cause::Report),
            stopping.map_err(Cause::Drain),
        );
        finalized(result, transport)?;
        self.completed = true;
        Ok(())
    }
    fn close_original_handlers(&mut self) -> Result<(), Cause> {
        let runtime = &self.broker.storage.runtime;
        let handlers = self.handlers.as_mut().expect("original counted selection");
        let bound = handlers.deadline(runtime)?;
        loop {
            let issued = handlers
                .advance_interruption(&self.connection, &self.broker.reports, runtime)
                .map_err(Cause::Handlers)?;
            if issued == WorkerOriginalInterruptionProgress::Issued {
                break;
            }
            wait(bound)?;
        }
        loop {
            if handlers.settle(runtime).map_err(Cause::Handlers)? == WorkerHandlersProgress::Settled
            {
                break;
            }
            wait(bound.min(runtime.stop_deadline().unwrap_or(bound)))?;
        }
        match self
            .handlers
            .take()
            .expect("same actual selection")
            .into_closed()
        {
            Ok(closed) => self.closed_handlers = Some(closed),
            Err(originals) => {
                self.handlers = Some(*originals);
                return Err(Cause::Refused("WORKER_DEPLOYMENT_HANDLERS_RETAINED"));
            }
        }
        Ok(())
    }
}
fn finalized(body: Result<(), Cause>, cleanup: Result<(), Cause>) -> Result<(), Cause> {
    match (body, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(Cause::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
fn wait(bound: Instant) -> Result<(), Cause> {
    let remaining = bound
        .checked_duration_since(Instant::now())
        .ok_or(Cause::Refused("WORKER_DEPLOYMENT_QUIESCE_DEADLINE"))?;
    std::thread::sleep(remaining.min(Duration::from_millis(1)));
    Ok(())
}
