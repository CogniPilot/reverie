use super::*;
use std::{fs::File, os::fd::AsFd};
pub(in crate::worker_laptop) struct Attempt {
    pub(super) files: crate::task_perf::capsule::GuestFiles,
    pin: Option<File>,
    close_unknown: bool,
}
impl Attempt {
    pub(super) fn unopened(capsule: crate::task_perf::capsule::InstalledCapsule) -> Self {
        Self {
            files: capsule.into_guest(),
            pin: None,
            close_unknown: false,
        }
    }
    pub(super) fn pin(&mut self, pid: u32) -> Result<()> {
        need(
            self.pin.is_none() && !self.close_unknown,
            "TASK_PERF_INIT_REPLAYED",
        )?;
        self.pin = Some(crate::native::perf_init_pidfd(pid).map_err(LaptopError::Io)?);
        self.live()
    }
    pub(super) fn live(&self) -> Result<()> {
        let pin = self
            .pin
            .as_ref()
            .ok_or(LaptopError::Refused("TASK_PERF_INIT_CLOSED"))?;
        let mut fds = [nix::poll::PollFd::new(
            pin.as_fd(),
            nix::poll::PollFlags::POLLIN,
        )];
        let ready = nix::poll::poll(&mut fds, nix::poll::PollTimeout::ZERO)
            .map_err(|error| LaptopError::Io(std::io::Error::from_raw_os_error(error as i32)))?;
        need(
            ready == 0 && fds[0].revents().is_some_and(|events| events.is_empty()),
            "TASK_PERF_INIT_ENDED",
        )
    }
    pub(super) fn close(&mut self) -> Result<()> {
        let files = self.files.close().map_err(capsule_error);
        let pin = self
            .pin
            .take()
            .map(crate::native::close)
            .transpose()
            .map(|_| ())
            .map_err(LaptopError::Observation);
        let result = finalized(files, pin);
        self.close_unknown |= result.is_err();
        result?;
        need(!self.close_unknown, "TASK_PERF_INIT_CLOSE_UNKNOWN")
    }
}
impl Drop for Attempt {
    fn drop(&mut self) {
        // This owner remains inside Creation, including after a body panic.
        // Actual record cleanup calls close_abandoned before any local ACK.
        std::mem::forget(self.pin.take());
    }
}
pub(super) fn get(record: &Record) -> &Attempt {
    record
        .creation
        .as_ref()
        .expect("actual creation")
        .worker_perf
        .as_ref()
        .expect("stored perf owner")
}
pub(super) fn get_mut(record: &mut Record) -> &mut Attempt {
    record
        .creation
        .as_mut()
        .expect("actual creation")
        .worker_perf
        .as_mut()
        .expect("stored perf owner")
}
pub(in crate::worker_laptop) fn close_abandoned(record: &mut Record) -> Result<()> {
    let Some(attempt) = record
        .creation
        .as_mut()
        .and_then(|creation| creation.worker_perf.as_mut())
    else {
        return Ok(());
    };
    let result = attempt.close();
    record.unknown |= result.is_err();
    result
}
