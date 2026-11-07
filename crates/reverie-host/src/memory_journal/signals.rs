//! Standalone CLI signal propagation only. The accepted signal syscall owner
//! remains unchanged; no session/grant or caller-selected signal callback exists.
use super::CancellationToken;
use crate::native::child_signals::{self, SignalGuard};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
#[derive(Debug)]
pub struct JournalSignalError {
    pub restoration_unconfirmed: bool,
}
impl std::fmt::Display for JournalSignalError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(if self.restoration_unconfirmed {
            "journal signal restoration is unconfirmed"
        } else {
            "journal signals could not be installed"
        })
    }
}
impl std::error::Error for JournalSignalError {}
#[must_use = "settle the journal child before checking signal restoration"]
pub struct JournalSignals {
    guard: Option<SignalGuard>,
    stop: Arc<AtomicBool>,
    watcher: Option<JoinHandle<()>>,
    token: CancellationToken,
    signal: Option<i32>,
    failed: bool,
}
impl JournalSignals {
    pub fn install_for_standalone_process() -> Result<Self, JournalSignalError> {
        let guard = SignalGuard::install().map_err(|error| JournalSignalError {
            restoration_unconfirmed: error.restoration_failed,
        })?;
        let stop = Arc::new(AtomicBool::new(false));
        let token = CancellationToken::new();
        let watched = Arc::clone(&stop);
        let cancelled = token.clone();
        let watcher = std::thread::Builder::new()
            .name("reverie-journal-signals".into())
            .spawn(move || watch(&watched, &cancelled));
        let watcher = match watcher {
            Ok(watcher) => watcher,
            Err(_) => {
                return Err(JournalSignalError {
                    restoration_unconfirmed: guard.finish().is_err(),
                });
            }
        };
        Ok(Self {
            guard: Some(guard),
            stop,
            watcher: Some(watcher),
            token,
            signal: None,
            failed: false,
        })
    }
    pub fn cancellation(&self) -> &CancellationToken {
        &self.token
    }
    pub fn termination_signal(&self) -> Option<i32> {
        self.signal.or_else(child_signals::signal)
    }
    pub fn cleanup_deadline(&self, deadline: Instant) -> Instant {
        child_signals::clamp(deadline)
    }
    pub fn finish(&mut self) -> Result<(), JournalSignalError> {
        if self.failed {
            return Err(JournalSignalError {
                restoration_unconfirmed: true,
            });
        }
        self.stop.store(true, Ordering::Release);
        self.signal = child_signals::signal();
        if let Some(watcher) = self.watcher.take()
            && watcher.join().is_err()
        {
            self.failed = true;
        }
        if let Some(guard) = self.guard.take()
            && guard.finish().is_err()
        {
            self.failed = true;
        }
        if self.failed {
            Err(JournalSignalError {
                restoration_unconfirmed: true,
            })
        } else {
            Ok(())
        }
    }
}
impl Drop for JournalSignals {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
fn watch(stop: &AtomicBool, cancellation: &CancellationToken) {
    while !stop.load(Ordering::Acquire) {
        if child_signals::signal().is_some() {
            cancellation.cancel();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consumed_restore_refusal_has_no_watcher_to_poll_and_remains_negative() {
        const CASE: &str = "REVERIE_OWNED_JOURNAL_SIGNAL_RESTORE";
        if std::env::var_os(CASE).is_none() {
            let output=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","memory_journal::signals::tests::consumed_restore_refusal_has_no_watcher_to_poll_and_remains_negative","--test-threads=1"]).env(CASE,"1").output().unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed;"));
            return;
        }
        let mut signals = JournalSignals::install_for_standalone_process().unwrap();
        child_signals::fail_restore_once();
        assert!(signals.finish().unwrap_err().restoration_unconfirmed);
        assert!(signals.guard.is_none());
        assert!(signals.watcher.is_none());
        assert!(signals.finish().unwrap_err().restoration_unconfirmed);
        assert!(
            JournalSignals::install_for_standalone_process().is_err(),
            "persistent negative fence is not reset"
        );
    }
}
