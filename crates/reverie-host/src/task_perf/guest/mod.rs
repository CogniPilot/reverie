//! Fixed unprivileged in-image profiler. No engine, program/path selection,
//! skipped capability result, admission grant, or host configuration change.
mod error;
mod facts;
mod workload;
mod workspace;
use crate::{
    captured_client::{
        CancellationToken, CapturedClient, CapturedOutput, InstalledCommand, Policy, nix_tail,
    },
    native,
};
pub use error::PerfCheckError;
use error::{Result, finalized, need};
use reverie_contracts::task_perf_check::{CHECKER, PERF, PerfCheckData};
use reverie_core::{operations::JournalId, shutdown::ShutdownStatus};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
pub use workload::run as run_fixed_workload;

#[must_use = "retain the actual guest owner and settle every native producer before returning a result"]
pub struct PerfGuestCheck {
    client: Option<CapturedClient>,
    workspace: Option<workspace::Workspace>,
    signals: Option<native::child_signals::SignalGuard>,
    unconfirmed_signal: Option<Arc<native::child_signals::SignalView>>,
    cancellation: CancellationToken,
    attempted: bool,
    close_unknown: bool,
    finalization_failed: bool,
    known_closed: bool,
    output: [Vec<u8>; 2],
}
impl PerfGuestCheck {
    pub fn installed() -> Result<Self> {
        need(
            std::env::current_exe()? == Path::new(CHECKER),
            "TASK_PERF_FIXED_CHECKER_REQUIRED",
        )?;
        Ok(Self {
            client: None,
            workspace: None,
            signals: None,
            unconfirmed_signal: None,
            cancellation: CancellationToken::new(),
            attempted: false,
            close_unknown: false,
            finalization_failed: false,
            known_closed: false,
            output: [Vec::new(), Vec::new()],
        })
    }
    pub fn check(&mut self, nonce: JournalId, deadline: Instant) -> Result<PerfCheckData> {
        need(!self.attempted, "TASK_PERF_CHECK_ALREADY_ATTEMPTED")?;
        self.attempted = true;
        let result = self.body(nonce, deadline);
        self.close_unknown |= result.as_ref().is_err_and(PerfCheckError::close_unknown);
        result
    }
    fn body(&mut self, nonce: JournalId, deadline: Instant) -> Result<PerfCheckData> {
        let before = facts::observe()?;
        self.prepare()?;
        self.run(
            &[
                "stat",
                "--no-big-num",
                "-x,",
                "--output",
                "stat.csv",
                "--event",
                "task-clock:u",
                "--",
                CHECKER,
                "--workload",
            ],
            deadline,
        )?;
        let stat = self.workspace.as_mut().expect("actual workspace").stat()?;
        self.run(
            &[
                "record",
                "--quiet",
                "--inherit",
                "--all-user",
                "--no-buildid-cache",
                "--no-buildid",
                "--mmap-pages",
                "64",
                "--freq",
                "99",
                "--event",
                "task-clock:u",
                "--max-size",
                "8M",
                "--output",
                "perf.data",
                "--",
                CHECKER,
                "--workload",
            ],
            deadline,
        )?;
        self.workspace
            .as_mut()
            .expect("actual workspace")
            .recording()?;
        let report = self.run(
            &["report", "--stdio", "--header", "--input", "perf.data"],
            deadline,
        )?;
        need(
            facts::observe()? == before,
            "TASK_PERF_KERNEL_FACTS_CHANGED",
        )?;
        Ok(PerfCheckData::from_perf(
            nonce,
            before.uid,
            before.paranoid,
            std::str::from_utf8(&stat)
                .map_err(|_| PerfCheckError::Refused("TASK_PERF_STAT_ENCODING"))?,
            std::str::from_utf8(&report.stdout)
                .map_err(|_| PerfCheckError::Refused("TASK_PERF_REPORT_ENCODING"))?,
        )?)
    }
    fn prepare(&mut self) -> Result<()> {
        // This standalone CLI has not created any threads yet.
        native::child_signals::private_umask();
        match native::child_signals::SignalGuard::install() {
            Ok(signals) => self.signals = Some(signals),
            Err(error) => {
                self.unconfirmed_signal = error.retained_view();
                return Err(PerfCheckError::Signal {
                    cause: error.cause,
                    restoration_failed: error.restoration_failed,
                });
            }
        }
        need(
            self.cancellation
                .bind_worker_signals(self.signals.as_ref().expect("actual signals").view()),
            "TASK_PERF_SIGNAL_BINDING_CHANGED",
        )?;
        self.workspace = Some(workspace::Workspace::unopened()?);
        let workspace = self
            .workspace
            .as_mut()
            .expect("owner stored before filesystem effect");
        workspace.create()?;
        let environment: BTreeMap<OsString, OsString> = [
            ("LC_ALL", "C"),
            ("LANG", "C"),
            ("PERF_CONFIG", "/dev/null"),
            ("HOME", "/nonexistent"),
            ("XDG_CONFIG_HOME", "/nonexistent"),
            ("PATH", "/opt/reverie/perf/bin"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        let command = InstalledCommand::from_service(
            std::ffi::OsStr::new(PERF),
            environment,
            workspace.directory()?,
        )
        .ok_or(PerfCheckError::Refused(
            "TASK_PERF_FIXED_PROGRAM_UNAVAILABLE",
        ))?;
        self.client = Some(CapturedClient::new(command));
        Ok(())
    }
    fn run(&mut self, arguments: &[&str], deadline: Instant) -> Result<CapturedOutput> {
        let output = self.client.as_ref().expect("retained fixed client").run(
            arguments
                .iter()
                .map(|value| OsString::from(*value))
                .collect(),
            deadline,
            &self.cancellation,
            Policy {
                maximum: Duration::from_secs(15),
                maximum_output: 2 * 1024 * 1024,
                successful_exit: false,
            },
        )?;
        nix_tail::append(&mut self.output[0], &output.stdout);
        nix_tail::append(&mut self.output[1], &output.stderr);
        if !output.succeeded {
            return Err(PerfCheckError::Child {
                code: output.shell_code,
            });
        }
        Ok(output)
    }
    pub fn diagnostics(&self) -> (&[u8], &[u8]) {
        (&self.output[0], &self.output[1])
    }
    pub fn termination_signal(&self) -> Option<i32> {
        native::child_signals::signal()
    }
    pub fn shutdown(&mut self, deadline: Instant) -> ShutdownStatus<PerfCheckError> {
        let deadline = native::child_signals::clamp(deadline);
        self.cancellation.cancel();
        self.close_unknown |= self.unconfirmed_signal.is_some();
        let mut result = need(
            !self.finalization_failed && !self.close_unknown,
            "TASK_PERF_CLOSE_UNKNOWN",
        );
        let mut pending = false;
        let mut known = true;
        if let Some(client) = &self.client {
            let closed = match client.shutdown(deadline) {
                ShutdownStatus::Complete => Ok(()),
                ShutdownStatus::Pending(error) => {
                    pending = true;
                    known = false;
                    Err(error.into())
                }
                ShutdownStatus::Refused(error) => {
                    known = false;
                    Err(error.into())
                }
            };
            result = finalized(result, closed);
        }
        if !pending {
            if let Some(workspace) = &mut self.workspace {
                result = finalized(result, workspace.close(known && !self.close_unknown));
            }
            if let Some(signals) = self.signals.take() {
                result = finalized(result, signals.finish().map_err(Into::into));
            }
        }
        self.finalization_failed |= result.is_err() && !pending;
        match result {
            Ok(()) => {
                self.known_closed = true;
                ShutdownStatus::Complete
            }
            Err(error) if pending => ShutdownStatus::Pending(error),
            Err(error) => ShutdownStatus::Refused(error),
        }
    }
}
impl Drop for PerfGuestCheck {
    fn drop(&mut self) {
        if !self.known_closed {
            // Abandonment is not checked finalization. Keep the original
            // process/pipe registry and metadata/signal owners alive; the
            // outer actual launch must retain its container on uncertainty.
            std::mem::forget(self.client.take());
            std::mem::forget(self.workspace.take());
            std::mem::forget(self.signals.take());
            std::mem::forget(self.unconfirmed_signal.take());
        }
    }
}
