use super::*;
use reverie_contracts::worker_launch::{TerminalFrame, decode_terminal_frame};
impl ViewerRelay<'_> {
    pub(super) fn step_inner(&mut self) -> RelayResult<ViewerRelayEvent> {
        if self.runtime.cancellation().is_cancelled() || !self.identity.can_progress() {
            self.ended = true;
            return Ok(ViewerRelayEvent::Ended(ViewerRelayEnd::Stopping));
        }
        self.connection.assert_open(self.runtime)?;
        let connection = self.connection;
        let mut stream = connection.terminal_socket()?;
        let ready = stream.ready(
            self.runtime,
            self.viewer,
            &self.identity,
            TerminalWait::Read {
                master: self.master_open,
            },
        )?;
        // Selector registration order is socket then master. Handle both ready
        // entries in that order without buffering additional frames.
        if ready.connection {
            let (header, payload) = stream.receive()?;
            match decode_terminal_frame(header.kind(), &payload).map_err(ViewerRelayError::Data)? {
                TerminalFrame::Input(bytes) => self.input(&stream, bytes)?,
                TerminalFrame::Resize(size) => self.resize_in_flight(size)?,
            }
        }
        if ready.master && self.master_open {
            self.output(&mut stream)?;
        }
        drop(stream);
        self.observe_resize()?;
        let completed = self
            .runtime
            .terminal_viewer_receipt(self.viewer, &self.identity)?;
        let receipt_seen = completed.is_some();
        let result = match completed {
            Some(bytes) if self.attached.elapsed() >= Duration::from_millis(500) => {
                Some((bytes, true))
            }
            Some(_) => None,
            None => self
                .runtime
                .laptop_viewer_status(self.viewer)?
                .map(|code| (code.to_string().into_bytes(), false)),
        };
        if let Some((bytes, receipt)) = result {
            let mut stream = self.connection.terminal_socket()?;
            self.drain(&mut stream)?;
            stream.exit(&bytes)?;
            self.ended = true;
            let reason = if receipt {
                ViewerRelayEnd::Receipt(bytes)
            } else {
                ViewerRelayEnd::ViewerExited(
                    std::str::from_utf8(&bytes)
                        .expect("native status ASCII")
                        .parse()
                        .expect("native i32 status"),
                )
            };
            return Ok(ViewerRelayEvent::Ended(reason));
        }
        if self.checked.elapsed() >= Duration::from_secs(2) {
            self.checked_completed = receipt_seen;
            self.await_intent = true;
            return Ok(ViewerRelayEvent::CheckCurrentIntent);
        }
        Ok(ViewerRelayEvent::Progress)
    }
    fn input(&self, stream: &socket::Socket<'_>, mut bytes: &[u8]) -> RelayResult<()> {
        #[cfg(test)]
        super::test_hooks::before_input();
        while !bytes.is_empty() {
            if self.runtime.cancellation().is_cancelled() || !self.identity.can_progress() {
                return Err(ViewerRelayError::Phase);
            }
            match self.runtime.write_laptop_viewer(self.viewer, bytes) {
                Ok(0) => {
                    return Err(WorkerReportError::Io(std::io::ErrorKind::WriteZero.into()).into());
                }
                Ok(n) => bytes = &bytes[n..],
                Err(crate::worker_laptop::LaptopError::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    #[cfg(test)]
                    super::test_hooks::write_wait(&error);
                    stream.ready(
                        self.runtime,
                        self.viewer,
                        &self.identity,
                        TerminalWait::Input,
                    )?;
                }
                Err(error) => {
                    // The frame has already been consumed. Keep THIS exact
                    // unwritten suffix; returning Progress would discard it.
                    self.retry_busy(error)?;
                }
            }
        }
        Ok(())
    }
    fn retry_busy(&self, error: crate::worker_laptop::LaptopError) -> RelayResult<()> {
        let error = ViewerRelayError::from(error);
        if !error.busy() {
            return Err(error);
        }
        self.wait_pending_operation()
    }
    fn resize_in_flight(
        &mut self,
        size: reverie_core::worker_launch::TerminalSize,
    ) -> RelayResult<()> {
        loop {
            match self.request_resize(size) {
                Err(error) if error.busy() => self.wait_pending_operation()?,
                result => return result,
            }
        }
    }
    fn wait_pending_operation(&self) -> RelayResult<()> {
        #[cfg(test)]
        super::test_hooks::saw_busy();
        if self.runtime.cancellation().is_cancelled() || !self.identity.can_progress() {
            return Err(ViewerRelayError::Phase);
        }
        std::thread::sleep(Duration::from_millis(1));
        Ok(())
    }
    fn output(&mut self, stream: &mut socket::Socket<'_>) -> RelayResult<()> {
        let mut bytes = [0; 65536];
        match self.runtime.read_laptop_viewer(self.viewer, &mut bytes) {
            Ok(0) => self.master_open = false,
            Ok(n) => stream.output(&bytes[..n])?,
            Err(crate::worker_laptop::LaptopError::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) => {}
            Err(crate::worker_laptop::LaptopError::Io(_)) => self.master_open = false,
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }
    fn drain(&self, stream: &mut socket::Socket<'_>) -> RelayResult<()> {
        let mut bytes = [0; 65536];
        loop {
            match self.runtime.read_laptop_viewer(self.viewer, &mut bytes) {
                Ok(0) | Err(crate::worker_laptop::LaptopError::Io(_)) => return Ok(()),
                Ok(n) => stream.output(&bytes[..n])?,
                Err(error) => return Err(error.into()),
            }
        }
    }
    pub(super) fn check_dead_pane(&mut self) -> RelayResult<()> {
        if self.checked_completed {
            return Ok(());
        }
        let end = Instant::now() + Duration::from_secs(2);
        let pane = match self
            .runtime
            .terminal_viewer_pane(self.viewer, &self.identity, end)
        {
            Ok(pane) => pane,
            Err(_) => return Ok(()),
        };
        if matches!(pane,TerminalObservation::Value(text) if reverie_core::python_trim_text(&text)=="1")
            && !self
                .runtime
                .terminal_viewer_has_receipt(self.viewer, &self.identity)?
        {
            return Err(ViewerRelayError::PaneDead);
        }
        Ok(())
    }
}
