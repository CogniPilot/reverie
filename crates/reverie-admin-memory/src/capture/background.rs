use super::{Completed, Limits, supervised};
use std::{
    io,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Instant,
};

type Outcome = io::Result<io::Result<Completed>>;

/// Cancellation joins capture only after its original child and group have settled.
pub(crate) struct Background {
    cancelled: Arc<AtomicBool>,
    handle: Option<JoinHandle<Outcome>>,
}

impl Background {
    pub(crate) fn start(
        name: &str,
        command: Command,
        body: Vec<u8>,
        deadline: Instant,
        cap: usize,
    ) -> io::Result<Self> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancelled);
        let handle = thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                supervised(
                    command,
                    Some(&body),
                    Limits::cancellable(deadline, cap, &flag),
                )
            })?;
        Ok(Self {
            cancelled,
            handle: Some(handle),
        })
    }

    pub(crate) fn take(&mut self) -> io::Result<Option<io::Result<Completed>>> {
        if !self.handle.as_ref().is_some_and(JoinHandle::is_finished) {
            return Ok(None);
        }
        self.handle.take().map(join).transpose()
    }

    pub(crate) fn cancel(&mut self) -> io::Result<()> {
        self.cancelled.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = join(handle)?;
        }
        Ok(())
    }
}

impl Drop for Background {
    fn drop(&mut self) {
        let _ = self.cancel();
    }
}

fn join(handle: JoinHandle<Outcome>) -> Outcome {
    handle
        .join()
        .map_err(|_| io::Error::other("Hands capture thread failed"))?
}
