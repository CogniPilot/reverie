use super::*;
use crate::{native::viewer_session::ViewerProcess, terminal_pty::OwnedPty};
use reverie_contracts::{worker_schema::WorkerEnvelope, worker_source_stop::OrdinaryContainer};
use reverie_core::{
    ids::{ContainerId, ProfileSessionId},
    worker_launch::{ContainerReference, TerminalSize},
};
use std::{ffi::OsString, os::unix::net::UnixStream};

pub(super) struct Target {
    container: ContainerId,
    binding: reverie_contracts::storage_identity::CurrentEmployee,
}
impl Target {
    pub(super) fn observe(
        service: &WorkerViewerService,
        config: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
        end: Instant,
    ) -> Result<Self> {
        let binding = crate::worker_intent::read_current_viewer_binding(config, session)
            .map_err(|cause| ViewerError::caused("WORKER_VIEWER_INTENT", cause))?
            .ok_or_else(|| ViewerError::refused("WORKER_VIEWER_EMPLOYEE_NOT_CURRENT"))?;
        let envelope = WorkerEnvelope::capture(config.clone())
            .map_err(|cause| ViewerError::caused("WORKER_VIEWER_CONFIGURATION", cause))?;
        let name =
            reverie_core::worker_laptop::WorkerContainerName::for_session(envelope.base(), session);
        let query = service.engine.readonly().capture_query_owner();
        let observed = query.inspect_laptop(&name, end, &service.engine.cancellation());
        let closed = query.settle_owned(end);
        let observed = match (observed, closed) {
            (Ok(observed), Ok(())) => observed,
            (Err(cause), Ok(())) => {
                return Err(ViewerError::caused("WORKER_VIEWER_INSPECT", cause));
            }
            (primary, Err(cause)) => {
                let mut error = ViewerError::caused("WORKER_VIEWER_INSPECT_CLEANUP", cause);
                // Native query ownership remains retained on uncertain cleanup;
                // keep this admission slot so repeated callers cannot exhaust it.
                error.retained = true;
                if let Err(cause) = primary {
                    error.secondary = Some(Box::new(ViewerError::caused(
                        "WORKER_VIEWER_INSPECT",
                        cause,
                    )));
                }
                return Err(error);
            }
        };
        if !observed.succeeded {
            return Err(ViewerError::refused("WORKER_VIEWER_LAPTOP_UNAVAILABLE"));
        }
        let row = OrdinaryContainer::decode(
            &observed.stdout,
            name.as_str(),
            envelope.base().deployment(),
            session,
        )
        .map_err(|cause| ViewerError::caused("WORKER_VIEWER_IDENTITY", cause))?;
        if !row.running() {
            return Err(ViewerError::refused("WORKER_VIEWER_LAPTOP_STOPPED"));
        }
        let raw: serde_json::Value = serde_json::from_slice(&observed.stdout)
            .map_err(|cause| ViewerError::caused("WORKER_VIEWER_IDENTITY", cause))?;
        if raw
            .as_array()
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("State"))
            .and_then(|state| state.get("Running"))
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        {
            return Err(ViewerError::refused("WORKER_VIEWER_LAPTOP_STOPPED"));
        }
        let labels = raw
            .as_array()
            .filter(|rows| rows.len() == 1)
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("Config"))
            .and_then(|config| config.get("Labels"));
        if labels
            .and_then(|labels| labels.get("reverie.employee"))
            .and_then(serde_json::Value::as_str)
            != Some(binding.identity().as_str())
        {
            return Err(ViewerError::refused("WORKER_VIEWER_EMPLOYEE_CHANGED"));
        }
        // Inspection is external I/O. Re-observe authority after it completes,
        // before a PTY or attach process may be created.
        let current = service.configuration()?;
        let current_binding = crate::worker_intent::read_current_viewer_binding(&current, session)
            .map_err(|cause| ViewerError::caused("WORKER_VIEWER_INTENT", cause))?;
        if !reverie_contracts::worker_config::equivalent(config, &current)
            || current_binding.as_ref() != Some(&binding)
        {
            return Err(ViewerError::refused("WORKER_VIEWER_TARGET_CHANGED"));
        }
        Ok(Self {
            container: row.id().clone(),
            binding,
        })
    }
}

pub(super) struct Attach {
    process: Option<ViewerProcess>,
    pty: Option<OwnedPty>,
    finalized: bool,
    group_attempted: bool,
    opaque_pty: bool,
}
impl Attach {
    pub(super) fn new() -> Self {
        Self {
            process: Some(ViewerProcess::default()),
            pty: None,
            finalized: false,
            group_attempted: false,
            opaque_pty: false,
        }
    }
    pub(super) fn start(
        &mut self,
        engine: &InstalledWorkerEngine,
        target: &Target,
        size: TerminalSize,
    ) -> Result<()> {
        self.pty = Some(match OwnedPty::open(size) {
            Ok(pty) => pty,
            Err(cause) => {
                self.opaque_pty = cause.close_uncertain();
                return Err(ViewerError::caused("WORKER_VIEWER_PTY", cause));
            }
        });
        let pty = self.pty.as_ref().expect("owned prepared PTY");
        let process = self.process.as_mut().expect("original attach process");
        process.prepare(pty.slave_fd()?)?;
        let mut marker = [0; 16];
        getrandom::getrandom(&mut marker)
            .map_err(|_| ViewerError::refused("WORKER_VIEWER_RANDOM"))?;
        let args = reverie_contracts::worker_launch::viewer_attach_arguments(
            &ContainerReference::Observed(&target.container),
            &marker,
        )
        .iter()
        .map(|value| {
            crate::native::python_path(value.codepoints()).map(|path| path.into_os_string())
        })
        .collect::<std::io::Result<Vec<OsString>>>()?;
        let capture = engine.engine.client.viewer_capture();
        let mut command = capture.viewer_command(&args)?;
        process.configure(&mut command);
        capture.configure_viewer_exact(&mut command, &args)?;
        let spawned = process.spawn(&mut command);
        let slave = self.pty.as_mut().expect("same original PTY").close_slave();
        spawned?;
        slave.map_err(|cause| ViewerError::caused("WORKER_VIEWER_PTY_CLOSE", cause))?;
        Ok(())
    }
    pub(super) fn relay(
        &self,
        service: &WorkerViewerService,
        stream: &mut UnixStream,
        request: &WorkerRequest,
        target: &Target,
    ) -> Result<()> {
        stream.set_nonblocking(true)?;
        let pty = self.pty.as_ref().expect("same attached PTY");
        let process = self.process.as_ref().expect("same attached process");
        let mut input = wire::Input::new();
        let mut pending = Vec::new();
        let mut checked = Instant::now();
        loop {
            if crate::native::child_signals::signal().is_some() {
                return Ok(());
            }
            if checked.elapsed() >= Duration::from_secs(2) {
                let current = service.configuration()?;
                let actual = Target::observe(
                    service,
                    &current,
                    request.session(),
                    Instant::now() + Duration::from_secs(5),
                )?;
                if actual.container != target.container || actual.binding != target.binding {
                    return Err(ViewerError::refused("WORKER_VIEWER_TARGET_CHANGED"));
                }
                checked = Instant::now();
            }
            let frame = if pending.is_empty() {
                input.next(stream)?
            } else {
                None
            };
            if let Some((kind, raw)) = frame {
                let current = service.configuration()?;
                let binding =
                    crate::worker_intent::read_current_viewer_binding(&current, request.session())
                        .map_err(|cause| ViewerError::caused("WORKER_VIEWER_INTENT", cause))?;
                if binding.as_ref() != Some(&target.binding) {
                    return Err(ViewerError::refused("WORKER_VIEWER_TARGET_CHANGED"));
                }
                match kind {
                    b'I' if pending.is_empty() => pending = raw,
                    b'R' => resize(pty, process, &raw)?,
                    _ => return Err(ViewerError::refused("WORKER_VIEWER_INPUT_FRAME")),
                }
            }
            if !pending.is_empty() {
                match pty.try_write(&pending) {
                    Ok(0) => return Err(ViewerError::refused("WORKER_VIEWER_INPUT_CLOSED")),
                    Ok(count) => {
                        pending.drain(..count);
                    }
                    Err(cause) if retry(&cause) => {}
                    Err(cause) => return Err(cause.into()),
                }
            }
            let mut raw = [0; 65_536];
            match pty.try_read(&mut raw) {
                Ok(0) => return Ok(()),
                Ok(count) => wire::send(stream, b'O', &raw[..count])?,
                Err(cause) if retry(&cause) => {}
                Err(cause) if cause.raw_os_error() == Some(libc::EIO) => return Ok(()),
                Err(cause) => return Err(cause.into()),
            }
            if let Some(status) = process.peek()? {
                return wire::send(
                    stream,
                    b'X',
                    &serde_json::to_vec(&status.shell_code())
                        .map_err(|_| ViewerError::refused("WORKER_VIEWER_EXIT"))?,
                );
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    pub(super) fn close(&mut self, end: Instant) -> Result<()> {
        let process = self.process.as_mut().expect("same attach process");
        process.finish_preparation();
        if process.needs_group_decision() && !self.group_attempted {
            self.group_attempted = true;
            process.kill_group()?;
        }
        while !process.settled() {
            process.reap()?;
            process.observe_group_absent()?;
            if Instant::now() >= end {
                return Err(ViewerError::refused("WORKER_VIEWER_CLEANUP_PENDING"));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        if let Some(pty) = self.pty.take() {
            pty.close()
                .map_err(|cause| ViewerError::caused("WORKER_VIEWER_PTY_CLOSE", cause))?;
        }
        if self.opaque_pty {
            return Err(ViewerError::refused("WORKER_VIEWER_PTY_CLOSE_PENDING"));
        }
        self.finalized = true;
        Ok(())
    }
}
impl Drop for Attach {
    fn drop(&mut self) {
        if !self.finalized {
            std::mem::forget((self.process.take(), self.pty.take()));
        }
    }
}
fn resize(pty: &OwnedPty, process: &ViewerProcess, raw: &[u8]) -> Result<()> {
    let [cols, rows] = serde_json::from_slice::<[u16; 2]>(raw)
        .map_err(|_| ViewerError::refused("WORKER_VIEWER_RESIZE"))?;
    let size = TerminalSize::try_new(cols, rows)
        .map_err(|_| ViewerError::refused("WORKER_VIEWER_RESIZE"))?;
    pty.resize(size)?;
    process.winch()?;
    Ok(())
}
fn retry(cause: &std::io::Error) -> bool {
    matches!(
        cause.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
    )
}
