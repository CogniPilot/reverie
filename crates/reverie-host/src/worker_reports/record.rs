use super::{
    WorkerReportError, WorkerReportService,
    error::{Result, finalized},
    wire,
};
use crate::command_telemetry::CommandTelemetry;
use std::{
    fs::File,
    os::{fd::OwnedFd, unix::net::UnixStream},
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(super) struct Record {
    stream: Mutex<Option<UnixStream>>,
    control: Mutex<Option<UnixStream>>,
    finished: AtomicBool,
    opaque: AtomicBool,
}
impl Record {
    pub(super) fn read_request(
        &self,
        service: &WorkerReportService,
        collector: &CommandTelemetry,
        configuration: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    ) -> Result<Option<reverie_contracts::worker_launch::WorkerRequest>> {
        let mut slot = self.lock(&self.stream);
        let stream = slot.as_mut().ok_or(WorkerReportError::Unconfirmed)?;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.prepare(stream)?;
            wire::authenticate(service, stream)?;
            collector.assert_engine(&service.engine)?;
            let (header, payload) = wire::receive(service, stream)?;
            match header.kind() {
                b'T' => {
                    wire::report(service, stream, collector, &payload)?;
                    Ok(None)
                }
                b'J' => {
                    reverie_contracts::worker_launch::WorkerRequest::decode(&payload, configuration)
                        .map(Some)
                        .map_err(WorkerReportError::Launch)
                }
                _ => Err(WorkerReportError::LaunchKind),
            }
        }))
        .unwrap_or_else(|_| {
            self.opaque.store(true, Ordering::Release);
            Err(WorkerReportError::Unconfirmed)
        });
        if let Err(error) = &result
            && !service.closed.load(Ordering::Acquire)
            && !error.quiet_disconnect()
        {
            let sent = wire::send(service, stream, b'E', error.wire_message().as_bytes());
            return finalized(result, sent);
        }
        result
    }
    /// Consume each actual socket descriptor once. Contention/poison/close
    /// refusal cannot turn the registered record into a completed connection.
    pub(super) fn finish_launch(&self, end: Instant) -> Result<()> {
        let interrupted = self.interrupt();
        let mut stream = match self.until(&self.stream, end) {
            Ok(stream) => stream,
            Err(error) => return finalized(interrupted, Err(error)),
        };
        let closed = stream.take().map_or(Ok(()), close);
        drop(stream);
        if interrupted.is_err() || closed.is_err() {
            self.opaque.store(true, Ordering::Release);
        }
        let mut control = match self.until(&self.control, end) {
            Ok(control) => control,
            Err(error) => return finalized(finalized(interrupted, closed), Err(error)),
        };
        let companion = control.take().map_or(Ok(()), close);
        drop(control);
        if interrupted.is_err() || closed.is_err() || companion.is_err() {
            self.opaque.store(true, Ordering::Release);
        }
        self.finished.store(true, Ordering::Release);
        let result = finalized(finalized(interrupted, closed), companion);
        if self.opaque.load(Ordering::Acquire) {
            finalized(result, Err(WorkerReportError::Unconfirmed))
        } else {
            result
        }
    }
    fn until<'a, T>(&self, lock: &'a Mutex<T>, end: Instant) -> Result<MutexGuard<'a, T>> {
        loop {
            match lock.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(std::sync::TryLockError::Poisoned(error)) => {
                    self.opaque.store(true, Ordering::Release);
                    return Ok(error.into_inner());
                }
                Err(std::sync::TryLockError::WouldBlock) => {}
            }
            if Instant::now() >= end {
                self.opaque.store(true, Ordering::Release);
                return Err(WorkerReportError::Unconfirmed);
            }
            std::thread::sleep(
                end.saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(1)),
            );
        }
    }
    pub(super) fn new(stream: UnixStream) -> Self {
        Self {
            stream: Mutex::new(Some(stream)),
            control: Mutex::new(None),
            finished: AtomicBool::new(false),
            opaque: AtomicBool::new(false),
        }
    }
    fn lock<'a, T>(&self, lock: &'a Mutex<T>) -> MutexGuard<'a, T> {
        lock.lock().unwrap_or_else(|error| {
            self.opaque.store(true, Ordering::Release);
            error.into_inner()
        })
    }
    fn prepare(&self, stream: &UnixStream) -> Result<()> {
        // The primary descriptor is already in this registered record. Acquire
        // its destination BEFORE duplication, so no partial clone drops unseen.
        let mut control = self.lock(&self.control);
        if control.is_some() {
            return Err(WorkerReportError::Unconfirmed);
        }
        *control = Some(stream.try_clone()?);
        Ok(())
    }
    pub(super) fn run(
        &self,
        service: &WorkerReportService,
        collector: &CommandTelemetry,
    ) -> Result<()> {
        let mut slot = self.lock(&self.stream);
        let result = match slot.as_mut() {
            Some(stream) => self
                .prepare(stream)
                .and_then(|()| self.operate(service, stream, collector)),
            None => {
                self.opaque.store(true, Ordering::Release);
                Err(WorkerReportError::Unconfirmed)
            }
        };
        let closed = slot.take().map_or(Ok(()), close);
        drop(slot);
        let control = self.lock(&self.control).take().map_or(Ok(()), close);
        if closed.is_err() || control.is_err() {
            self.opaque.store(true, Ordering::Release);
        }
        let result = finalized(finalized(result, closed), control);
        self.finished.store(true, Ordering::Release);
        result
    }
    fn operate(
        &self,
        service: &WorkerReportService,
        stream: &mut UnixStream,
        collector: &CommandTelemetry,
    ) -> Result<()> {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wire::operate(service, stream, collector)
        }))
        .unwrap_or_else(|_| {
            self.opaque.store(true, Ordering::Release);
            Err(WorkerReportError::Unconfirmed)
        });
        if let Err(error) = &result
            && !service.closed.load(Ordering::Acquire)
            && !error.quiet_disconnect()
        {
            // One error transport attempt, never a collector retry. The
            // original first-stop deadline still bounds this attempt.
            let payload = error.wire_message().as_bytes();
            let sent = wire::send(service, stream, b'E', payload);
            return finalized(result, sent);
        }
        result
    }
    pub(super) fn interrupt(&self) -> Result<()> {
        let slot = match self.control.try_lock() {
            Ok(slot) => slot,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(()),
            Err(std::sync::TryLockError::Poisoned(error)) => {
                self.opaque.store(true, Ordering::Release);
                error.into_inner()
            }
        };
        let result = slot.as_ref().map_or(Ok(()), wire::shutdown);
        if result.is_err() {
            self.opaque.store(true, Ordering::Release);
        }
        result
    }
    pub(super) fn settled(&self) -> bool {
        self.finished() && !self.opaque.load(Ordering::Acquire)
    }
    pub(super) fn finished(&self) -> bool {
        self.finished.load(Ordering::Acquire)
    }
    pub(super) fn can_progress(&self) -> bool {
        !self.finished() && !self.opaque.load(Ordering::Acquire)
    }
    #[cfg(test)]
    pub(super) fn control_ready(&self) -> bool {
        self.control.try_lock().is_ok_and(|slot| slot.is_some())
    }
}
pub(super) fn close(stream: UnixStream) -> Result<()> {
    #[cfg(test)]
    super::tests::before_close();
    let fd: OwnedFd = stream.into();
    let result = crate::native::close(File::from(fd)).map_err(|_| WorkerReportError::Unconfirmed);
    #[cfg(test)]
    if super::tests::refuse_close() {
        return Err(WorkerReportError::Unconfirmed);
    }
    result
}
