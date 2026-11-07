use super::*;
use reverie_contracts::worker_launch::viewer_clients;
use reverie_core::worker_launch::TerminalSize;
struct Request {
    identity: Arc<()>,
    size: TerminalSize,
    end: Instant,
    observed: Option<(u16, u16)>,
}
#[derive(Default)]
struct ClientObservation {
    ours: Vec<(u16, u16)>,
    unread: bool,
}
#[derive(Default)]
pub(super) struct Resize {
    pending: Option<Request>,
    blocked: Option<&'static str>,
    observed_at: Option<Instant>,
}
impl ViewerRelay<'_> {
    pub(super) fn request_resize(&mut self, size: TerminalSize) -> RelayResult<()> {
        self.runtime
            .terminal_resize_viewer(self.viewer, &self.identity, size)?;
        let identity = Arc::new(());
        self.resize.pending = Some(Request {
            identity: identity.clone(),
            size,
            end: Instant::now() + Duration::from_secs(5),
            observed: None,
        });
        self.signal_resize(&identity)?;
        if let Some(reason) = self.resize.blocked {
            self.finish_resize(&identity, reason)?;
        }
        Ok(())
    }
    pub(super) fn observe_resize(&mut self) -> RelayResult<()> {
        let Some(request) = &self.resize.pending else {
            return Ok(());
        };
        if self.resize.blocked.is_some()
            || self
                .resize
                .observed_at
                .is_some_and(|last| last.elapsed() < Duration::from_millis(250))
        {
            return Ok(());
        }
        let identity = request.identity.clone();
        self.resize.observed_at = Some(Instant::now());
        let Some(rows) = self.resize_query(&identity, None)? else {
            return Ok(());
        };
        let Some(observation) = self.matching_clients(&identity, &rows)? else {
            return Ok(());
        };
        if self.acknowledge_resize(&identity, observation)? {
            return Ok(());
        }
        self.signal_resize(&identity)
    }
    fn matching_clients(
        &mut self,
        identity: &Arc<()>,
        rows: &str,
    ) -> RelayResult<Option<ClientObservation>> {
        let mut observation = ClientObservation::default();
        let Some(clients) = viewer_clients(rows) else {
            return Ok(Some(observation));
        };
        let marker = self.runtime.terminal_viewer_marker(self.viewer)?;
        for client in clients {
            let environment = self.resize_query(identity, Some(client))?;
            if !self.same_resize(identity) {
                return Ok(None);
            }
            match environment {
                Some(environment) if environment.split('\0').any(|entry| entry == marker) => {
                    observation.ours.push(client.dimensions())
                }
                None => observation.unread = true,
                Some(_) => {}
            }
        }
        Ok(Some(observation))
    }
    fn acknowledge_resize(
        &mut self,
        identity: &Arc<()>,
        observation: ClientObservation,
    ) -> RelayResult<bool> {
        if observation.ours.len() != 1 || observation.unread {
            return Ok(false);
        }
        let observed = observation.ours[0];
        let request = self.resize.pending.as_mut().expect("same actual request");
        request.observed = Some(observed);
        if observed != (request.size.cols(), request.size.rows()) {
            return Ok(false);
        }
        if self.current_resize(identity)? {
            self.resize.pending = None;
        }
        Ok(true)
    }
    fn resize_query(
        &mut self,
        identity: &Arc<()>,
        client: Option<reverie_contracts::worker_launch::ViewerClient>,
    ) -> RelayResult<Option<String>> {
        if !self.current_resize(identity)? {
            return Ok(None);
        }
        let end = self.stop_bound(self.resize.pending.as_ref().expect("current request").end);
        if end.saturating_duration_since(Instant::now()) < Duration::from_secs(1) {
            return Ok(None);
        }
        let observed = match client {
            Some(client) => self.runtime.terminal_viewer_environment(
                self.viewer,
                &self.identity,
                client,
                end,
            )?,
            None => self
                .runtime
                .terminal_viewer_clients(self.viewer, &self.identity, end)?,
        };
        match observed {
            TerminalObservation::CleanupUnconfirmed => {
                self.resize.blocked = Some("CLEANUP_UNCONFIRMED");
                self.finish_resize(identity, "CLEANUP_UNCONFIRMED")?;
                Ok(None)
            }
            TerminalObservation::Unavailable => {
                self.finish_resize(identity, "UNAVAILABLE")?;
                Ok(None)
            }
            TerminalObservation::Value(text) if self.current_resize(identity)? => Ok(Some(text)),
            TerminalObservation::Value(_) | TerminalObservation::Missed => {
                self.current_resize(identity)?;
                Ok(None)
            }
        }
    }
    fn signal_resize(&mut self, identity: &Arc<()>) -> RelayResult<()> {
        if !self.current_resize(identity)? {
            return Ok(());
        }
        match self
            .runtime
            .terminal_signal_viewer(self.viewer, &self.identity)
        {
            Ok(()) => Ok(()),
            Err(error) => {
                let error = ViewerRelayError::from(error);
                if error.busy() { Ok(()) } else { Err(error) }
            }
        }
    }
    fn same_resize(&self, identity: &Arc<()>) -> bool {
        self.resize
            .pending
            .as_ref()
            .is_some_and(|request| Arc::ptr_eq(&request.identity, identity))
    }
    fn current_resize(&mut self, identity: &Arc<()>) -> RelayResult<bool> {
        if !self.same_resize(identity) {
            return Ok(false);
        }
        if self.runtime.cancellation().is_cancelled() || !self.identity.can_progress() {
            self.resize.pending = None;
            return Ok(false);
        }
        match self.runtime.laptop_viewer_status(self.viewer) {
            Ok(Some(_)) => {
                self.resize.pending = None;
                return Ok(false);
            }
            Ok(None) => {}
            Err(error) => {
                let error = ViewerRelayError::from(error);
                return if error.busy() { Ok(false) } else { Err(error) };
            }
        }
        if Instant::now() >= self.resize.pending.as_ref().expect("same request").end {
            self.finish_resize(identity, "EXPIRED")?;
            return Ok(false);
        }
        Ok(true)
    }
    fn finish_resize(&mut self, identity: &Arc<()>, reason: &'static str) -> RelayResult<()> {
        if !self.same_resize(identity) {
            return Ok(());
        }
        let request = self.resize.pending.take().expect("same actual request");
        let observed = request
            .observed
            .map_or_else(|| "none".into(), |(cols, rows)| format!("{cols}x{rows}"));
        let report = format!(
            "Reverie worker: terminal resize to {}x{} unconfirmed ({reason}); last observed {observed}\n",
            request.size.cols(),
            request.size.rows()
        );
        reverie_diagnostics::terminal_resize_report(report.as_bytes())
            .map_err(WorkerReportError::Io)?;
        Ok(())
    }
}
