//! Actual broker signal custody on the same captured engine. There is no
//! watcher thread or caller-supplied deadline: cancellation and cleanup read
//! the original native first-signal observation directly.
use super::*;
use crate::native::child_signals::{SignalGuard, SignalView};
use std::{
    fmt, io,
    sync::{Mutex, OnceLock},
};
#[cfg(test)]
mod tests;

#[derive(Debug)]
pub struct BrokerSignalError {
    code: &'static str,
    cause: Option<io::Error>,
    restoration_unconfirmed: bool,
}
impl BrokerSignalError {
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn restoration_unconfirmed(&self) -> bool {
        self.restoration_unconfirmed
    }
    fn refused(code: &'static str) -> Self {
        Self {
            code,
            cause: None,
            restoration_unconfirmed: false,
        }
    }
}
impl fmt::Display for BrokerSignalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for BrokerSignalError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_ref().map(|error| error as _)
    }
}
/// A failed partial installation retains its actual origin and static handler
/// observation. Its error is never permission to install a replacement source.
#[must_use = "retain partial signal installation through checked cleanup"]
pub struct BrokerSignalFailure {
    error: BrokerSignalError,
    owner: Option<Box<BrokerSignals>>,
}
impl BrokerSignalFailure {
    pub fn error(&self) -> &BrokerSignalError {
        &self.error
    }
    pub fn finish_after_runtime_close(&mut self) -> Result<(), BrokerSignalError> {
        self.owner
            .as_deref_mut()
            .map_or(Ok(()), BrokerSignals::finish_after_runtime_close)
    }
}
impl fmt::Debug for BrokerSignalFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BrokerSignalFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}
impl fmt::Display for BrokerSignalFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.error.fmt(f)
    }
}
impl std::error::Error for BrokerSignalFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}
#[must_use = "retain installed signals until actual service cleanup and runtime close"]
pub struct BrokerSignals {
    engine: Arc<InstalledWorkerEngine>,
    guard: Option<SignalGuard>,
    view: Arc<SignalView>,
    failed: bool,
    finished: bool,
}
impl WorkerRuntime {
    /// The standalone broker calls this after successful bootstrap, before
    /// recovery/listen. Only one genuine native installation is attempted on
    /// this engine. Another service's active guard cannot become its source.
    pub fn install_broker_signals(&self) -> Result<BrokerSignals, BrokerSignalFailure> {
        let engine = self.installed_engine().clone();
        if engine.cancellation().is_cancelled() {
            return Err(BrokerSignalFailure {
                error: BrokerSignalError::refused("WORKER_BROKER_STOPPING"),
                owner: None,
            });
        }
        if !engine.reserve_broker_signals() {
            return Err(BrokerSignalFailure {
                error: BrokerSignalError::refused("WORKER_SIGNALS_ALREADY_ATTEMPTED"),
                owner: None,
            });
        }
        match SignalGuard::install() {
            Ok(guard) => install(engine, guard),
            Err(error) => {
                let owner = error.retained_view().map(|view| {
                    let _ = engine.cancellation().bind_worker_signals(view.clone());
                    engine.request_stop();
                    Box::new(BrokerSignals {
                        engine,
                        guard: None,
                        view,
                        failed: true,
                        finished: false,
                    })
                });
                Err(BrokerSignalFailure {
                    error: BrokerSignalError {
                        code: "WORKER_SIGNAL_INSTALL_FAILED",
                        cause: Some(error.cause),
                        restoration_unconfirmed: error.restoration_failed,
                    },
                    owner,
                })
            }
        }
    }
}
fn install(
    engine: Arc<InstalledWorkerEngine>,
    guard: SignalGuard,
) -> Result<BrokerSignals, BrokerSignalFailure> {
    let view = guard.view();
    let bound = engine.cancellation().bind_worker_signals(view.clone());
    let owner = BrokerSignals {
        engine,
        guard: Some(guard),
        view,
        failed: !bound,
        finished: false,
    };
    if !bound {
        return Err(BrokerSignalFailure {
            error: BrokerSignalError {
                code: "WORKER_SIGNAL_CONTEXT_UNCONFIRMED",
                cause: None,
                restoration_unconfirmed: true,
            },
            owner: Some(Box::new(owner)),
        });
    }
    Ok(owner)
}
impl BrokerSignals {
    pub fn termination_signal(&self) -> Option<i32> {
        self.view.signal()
    }
    /// This checks only native signal restoration after the same captured
    /// client was actually sealed and closed. App must first settle all of its
    /// real handlers/Office/storage owners; this is no global release ACK.
    pub fn finish_after_runtime_close(&mut self) -> Result<(), BrokerSignalError> {
        if self.failed {
            return Err(BrokerSignalError {
                code: "WORKER_SIGNAL_RESTORATION_UNCONFIRMED",
                cause: None,
                restoration_unconfirmed: true,
            });
        }
        if self.finished {
            return Ok(());
        }
        if !self.engine.signal_restoration_ready() {
            return Err(BrokerSignalError::refused(
                "WORKER_SIGNAL_RUNTIME_NOT_CLOSED",
            ));
        }
        if let Some(guard) = self.guard.take()
            && let Err(cause) = guard.finish()
        {
            self.failed = true;
            return Err(BrokerSignalError {
                code: "WORKER_SIGNAL_RESTORATION_UNCONFIRMED",
                cause: Some(cause),
                restoration_unconfirmed: true,
            });
        }
        self.finished = true;
        Ok(())
    }
}
impl Drop for BrokerSignals {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.engine.request_stop();
        // Keep the actual native guard live: restoration/reset while pending
        // work exists could erase its earlier signal observation. No cycle or
        // replacement engine is created, and no extra thread is started.
        type Abandoned = (
            Arc<InstalledWorkerEngine>,
            Option<SignalGuard>,
            Arc<SignalView>,
        );
        static ABANDONED: OnceLock<Mutex<Vec<Abandoned>>> = OnceLock::new();
        ABANDONED
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push((self.engine.clone(), self.guard.take(), self.view.clone()));
    }
}
