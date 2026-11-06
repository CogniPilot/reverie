use super::control::Job;
use super::{
    CapturedOutput, CleanupFault, Error as EngineError, Fault as EngineFault, InstalledCommand,
    Result, native,
};
use std::{ffi::OsString, io, os::fd::OwnedFd, time::Instant};

#[derive(Default)]
pub(super) struct Process {
    registration: Option<std::fs::File>,
    prepared_registration: Option<native::RegistrationInput>,
    handshake: Option<native::Handshake>,
    identity: Option<OwnedFd>,
    streams: [Option<OwnedFd>; 2],
    nonblocking: [bool; 2],
    output: [Vec<u8>; 2],
    status: Option<native::ProcessStatus>,
    attempted: bool,
    started: bool,
    kill_attempted: bool,
    faults: Vec<CleanupFault>,
    opaque: bool,
}
impl Process {
    /// Observation only: opaque consumed failures remain negative, but cannot
    /// be mistaken for a constructor, child or descriptor still owned here.
    pub(super) fn has_pending_native_work(&self) -> bool {
        self.registration.is_some()
            || self.prepared_registration.is_some()
            || self.handshake.is_some()
            || self.identity.is_some()
            || self.streams.iter().any(Option::is_some)
            || (self.attempted && self.status.is_none())
    }
    pub(super) fn with_registration(input: Option<std::fs::File>) -> Self {
        Self {
            registration: input,
            ..Self::default()
        }
    }
    pub(super) fn start(
        &mut self,
        bootstrap: &InstalledCommand,
        args: &[OsString],
        job: &Job,
    ) -> Result<()> {
        self.prepare_registration()?;
        let preparation = native::Handshake::new();
        #[cfg(test)]
        let preparation = bootstrap.hooks.prepared(preparation);
        self.handshake = Some(
            preparation
                .map_err(|error| self.preparation_failed(error, CleanupFault::HandshakeClose))?,
        );
        let mut command = bootstrap.command(args);
        self.handshake
            .as_ref()
            .expect("prepared handshake")
            .configure(&mut command);
        if let Some(input) = &self.prepared_registration {
            input.configure(&mut command);
        }
        bootstrap
            .configure_exact(&mut command, args)
            .map_err(|_| EngineError::new(EngineFault::Spawn))?;
        self.attempted = true;
        #[cfg(test)]
        bootstrap.hooks.before_spawn();
        let result = command.spawn();
        self.close_registration(job);
        match result {
            Err(_) => {
                self.attempted = false;
                self.finish_handshake();
                return Err(EngineError::new(EngineFault::Spawn));
            }
            Ok(mut child) => {
                self.started = true;
                self.streams = [
                    child.stdout.take().map(Into::into),
                    child.stderr.take().map(Into::into),
                ];
                // The pidfd owns identity/waiting. Child::drop neither waits
                // nor signals, and its two owned pipe handles were moved above.
                drop(child);
            }
        }
        self.prepare_streams()?;
        self.acquire_identity()?;
        self.finish_handshake();
        if self.opaque {
            return Err(EngineError::new(EngineFault::Finalization));
        }
        Ok(())
    }
    fn prepare_registration(&mut self) -> Result<()> {
        if let Some(input) = self.registration.take() {
            self.prepared_registration = Some(
                native::RegistrationInput::prepare(input.into()).map_err(|error| {
                    self.preparation_failed(error, CleanupFault::RegistrationClose)
                })?,
            );
        }
        Ok(())
    }
    fn close_registration(&mut self, job: &Job) {
        let closed = if let Some(input) = self.prepared_registration.take() {
            Some(input.finish())
        } else {
            self.registration
                .take()
                .map(|input| native::close(input.into()))
        };
        if let Some(closed) = closed {
            #[cfg(test)]
            let closed = job.hooks.registration_closed(closed);
            #[cfg(not(test))]
            let _ = job;
            if closed.is_err() {
                self.failed(CleanupFault::RegistrationClose, true);
            }
        }
    }
    fn prepare_streams(&mut self) -> Result<()> {
        for index in 0..2 {
            if self.nonblocking[index] || self.streams[index].is_none() {
                continue;
            }
            native::nonblocking(self.streams[index].as_ref().expect("live stream"))
                .map_err(|_| EngineError::new(EngineFault::Identity))?;
            self.nonblocking[index] = true;
        }
        Ok(())
    }
    fn acquire_identity(&mut self) -> Result<()> {
        if self.identity.is_none() {
            let received = self
                .handshake
                .as_ref()
                .ok_or_else(|| EngineError::new(EngineFault::Identity))?
                .receive();
            match received {
                Ok(fd) => self.identity = Some(fd),
                Err(error) => return Err(self.receive_failed(error)),
            }
        }
        Ok(())
    }
    fn receive_failed(&mut self, error: native::ReceiveError) -> EngineError {
        if error.close_failed {
            self.failed(CleanupFault::HandshakeClose, true);
        }
        EngineError::new(EngineFault::Identity)
    }
    fn preparation_failed(
        &mut self,
        error: native::PreparationError,
        fault: CleanupFault,
    ) -> EngineError {
        if error.close_failed {
            self.failed(fault, true);
        }
        EngineError::new(EngineFault::Spawn)
    }
    fn finish_handshake(&mut self) {
        if let Some(mut handshake) = self.handshake.take()
            && handshake.finish().is_err()
        {
            self.failed(CleanupFault::HandshakeClose, true);
        }
    }
    fn failed(&mut self, fault: CleanupFault, opaque: bool) {
        if !self.faults.contains(&fault) {
            self.faults.push(fault);
        }
        self.opaque |= opaque;
    }
    fn reap(&mut self, job: &Job) -> Result<()> {
        #[cfg(not(test))]
        let _ = job;
        if self.status.is_some() || !self.started {
            return Ok(());
        }
        #[cfg(test)]
        if job.hooks.defer_reap() {
            return Ok(());
        }
        let fd = self
            .identity
            .as_ref()
            .ok_or_else(|| EngineError::new(EngineFault::Identity))?;
        self.status =
            native::reap_status(fd).map_err(|_| EngineError::new(EngineFault::Identity))?;
        Ok(())
    }
    fn stream(&mut self, index: usize, capture: bool, job: &Job) -> Result<()> {
        if capture && job.cancelled() {
            return Err(EngineError::new(EngineFault::Cancelled));
        }
        let Some(fd) = &self.streams[index] else {
            return Ok(());
        };
        if !self.nonblocking[index] {
            return Err(EngineError::new(EngineFault::Identity));
        }
        let mut buffer = [0u8; 65_536];
        match native::read(fd, &mut buffer) {
            Ok(0) => {
                self.close_stream(index, job)?;
            }
            Ok(count) if capture => {
                #[cfg(test)]
                job.hooks
                    .reads
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if job.nix_tail {
                    super::nix_tail::append(&mut self.output[index], &buffer[..count]);
                } else if self.output.iter().map(Vec::len).sum::<usize>() + count
                    > job.policy.maximum_output
                {
                    return Err(EngineError::new(EngineFault::OutputBound));
                } else {
                    self.output[index].extend_from_slice(&buffer[..count]);
                }
            }
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return Err(EngineError::new(EngineFault::Read)),
        }
        Ok(())
    }
    fn close_stream(&mut self, index: usize, job: &Job) -> Result<()> {
        let fd = self.streams[index].take().expect("live stream");
        let closed = native::close(fd);
        #[cfg(test)]
        let closed = job.hooks.closed(index, closed);
        #[cfg(not(test))]
        let _ = job;
        if closed.is_ok() {
            return Ok(());
        }
        let fault = if index == 0 {
            CleanupFault::StdoutClose
        } else {
            CleanupFault::StderrClose
        };
        self.failed(fault, true);
        Err(EngineError::new(EngineFault::Finalization))
    }
    fn complete(&self) -> bool {
        self.registration.is_none()
            && self.prepared_registration.is_none()
            && (!self.attempted || self.status.is_some())
            && self.streams.iter().all(Option::is_none)
    }
    fn poll(&self, deadline: Instant) {
        let mut fds = self.streams.iter().flatten().collect::<Vec<_>>();
        if self.status.is_none() {
            fds.extend(self.identity.iter());
        }
        let milliseconds = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(10) as i32;
        if !fds.is_empty() {
            let _ = native::poll(&fds, milliseconds);
        } else if milliseconds > 0 {
            std::thread::sleep(std::time::Duration::from_millis(milliseconds as u64));
        }
    }
    pub(super) fn observe(&mut self, deadline: Instant, job: &Job) -> Result<CapturedOutput> {
        loop {
            if job.cancelled() {
                return Err(EngineError::new(EngineFault::Cancelled));
            }
            if Instant::now() >= deadline {
                return Err(EngineError::new(EngineFault::Deadline));
            }
            self.reap(job)?;
            for index in 0..2 {
                self.stream(index, true, job)?;
            }
            if self.complete() {
                break;
            }
            self.poll(deadline);
        }
        for output in &mut self.output {
            if job.nix_tail {
                super::nix_tail::finish(output);
            } else {
                std::str::from_utf8(output).map_err(|_| EngineError::new(EngineFault::Utf8))?;
            }
        }
        let status = self
            .status
            .expect("complete process has actual exit status");
        if job.policy.successful_exit && !status.successful() {
            return Err(EngineError::new(EngineFault::Exit));
        }
        Ok(CapturedOutput {
            stdout: std::mem::take(&mut self.output[0]),
            stderr: std::mem::take(&mut self.output[1]),
            succeeded: status.successful(),
            shell_code: status.shell_code(),
        })
    }
    pub(super) fn cleanup(&mut self, deadline: Instant, job: &Job) -> bool {
        let deadline = if job.nix_tail {
            crate::native::child_signals::clamp(deadline)
        } else {
            deadline
        };
        self.close_registration(job);
        if self.prepare_streams().is_err() {
            self.failed(CleanupFault::Identity, false);
        }
        if self.attempted
            && self.identity.is_none()
            && self.status.is_none()
            && self.acquire_identity().is_err()
        {
            self.failed(CleanupFault::Identity, false);
            return false;
        }
        if self.identity.is_some() {
            self.started = true;
        }
        self.finish_handshake();
        if self.reap(job).is_err() {
            self.failed(CleanupFault::Identity, false);
        }
        if self.started && self.status.is_none() && !self.kill_attempted {
            self.kill_attempted = true;
            if let Some(fd) = &self.identity
                && let Err(error) = native::kill(fd)
                && error.raw_os_error() != Some(libc::ESRCH)
            {
                self.failed(CleanupFault::Signal, false);
            }
        }
        loop {
            if self.reap(job).is_err() {
                self.failed(CleanupFault::Identity, false);
            }
            for index in 0..2 {
                let _ = self.stream(index, false, job);
            }
            if self.complete() {
                self.close_identity();
                return !self.opaque;
            }
            if Instant::now() >= deadline {
                return false;
            }
            self.poll(deadline);
        }
    }
    fn close_identity(&mut self) {
        if let Some(fd) = self.identity.take()
            && native::close(fd).is_err()
        {
            self.failed(CleanupFault::PidfdClose, true);
        }
    }
    pub(super) fn report(&self, mut error: EngineError) -> EngineError {
        error.may_have_started |= self.started;
        error.cleanup.extend(
            self.faults
                .iter()
                .filter(|fault| !error.cleanup.contains(fault))
                .copied()
                .collect::<Vec<_>>(),
        );
        if self.attempted && self.status.is_none() {
            error.cleanup.push(CleanupFault::Unreaped);
        }
        if self.streams.iter().any(Option::is_some) {
            error.cleanup.push(CleanupFault::OpenPipes);
        }
        error.uncertain |= self.opaque || !self.complete();
        error
    }
    pub(super) fn mark_unknown(&mut self) {
        self.failed(CleanupFault::Supervisor, true);
    }
    pub(super) fn finish(
        &mut self,
        result: Result<CapturedOutput>,
        deadline: Instant,
        job: &Job,
    ) -> Result<CapturedOutput> {
        match result {
            Ok(value) => {
                self.close_identity();
                if self.opaque {
                    Err(self.report(EngineError::new(EngineFault::Finalization)))
                } else {
                    Ok(value)
                }
            }
            Err(error) => {
                self.cleanup(deadline, job);
                Err(self.report(error))
            }
        }
    }
}
