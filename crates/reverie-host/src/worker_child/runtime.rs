use super::{
    ChildCause, ChildCleanup, ChildError, ChildPhase, RecordDisposition, directory,
    error::Result,
    process::{self, OwnedProcess},
    receipt, record,
};
use crate::{
    engine_metadata::CancellationToken,
    native::{
        self,
        child_signals::{self, SignalGuard},
        ordered_exec::PreparedExec,
    },
};
use reverie_contracts::worker_child::{PrivateChildRecord, project_temporary_root};
use reverie_core::{
    PythonText,
    worker_child::{ChildEnvironment, ChildEnvironmentValue, TemporaryEnvironmentRoot},
};
use std::{
    convert::Infallible,
    ffi::OsString,
    fs,
    os::unix::{ffi::OsStrExt, fs::FileTypeExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
static CAPTURED: AtomicBool = AtomicBool::new(false);
const START_SECONDS: u64 = 20;
struct Bootstrap {
    root: PathBuf,
    shim: PathBuf,
    model_socket: PathBuf,
    model: PathBuf,
    office: PathBuf,
    bash: PathBuf,
    pane_program: PathBuf,
}
impl Bootstrap {
    fn installed() -> Self {
        Self {
            root: "/home/agent/.reverie-launch".into(),
            shim: "/opt/reverie/autoenv/bin".into(),
            model_socket: "/run/reverie-model/default.sock".into(),
            model: "/bin/reverie-model-relay".into(),
            office: "/bin/reverie-office-relay".into(),
            bash: "/bin/bash".into(),
            pane_program: "/proc/self/exe".into(),
        }
    }
}
/// Standalone in-worker runtime, not a broker/host command API. Keep this one
/// context until finish confirms every owned process/descriptor is settled.
/// Dropping it is never a successful cleanup acknowledgement or retry permit.
#[must_use = "retain runtime and check finish; pending children cannot be replaced"]
pub struct WorkerChildRuntime {
    bootstrap: Bootstrap,
    cancel: CancellationToken,
    relays: Vec<OwnedProcess>,
    signals: Option<SignalGuard>,
    signals_failed: bool,
    attempted: bool,
    spent: RecordDisposition,
    finalized: bool,
    cleanup_ceiling: Option<Instant>,
}
impl WorkerChildRuntime {
    pub fn installed() -> Result<Self> {
        if CAPTURED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(failure(
                ChildPhase::Record,
                ChildCause::Scope,
                RecordDisposition::Untouched,
            ));
        }
        native::child_signals::private_umask();
        let signals = match SignalGuard::install() {
            Ok(signals) => signals,
            Err(error) => {
                if !error.restoration_failed {
                    CAPTURED.store(false, Ordering::Release);
                }
                let failure = failure(
                    ChildPhase::Record,
                    ChildCause::Io(error.cause),
                    RecordDisposition::Untouched,
                );
                return Err(if error.restoration_failed {
                    failure.finalizer(ChildCleanup::Signal)
                } else {
                    failure
                });
            }
        };
        Ok(Self {
            bootstrap: Bootstrap::installed(),
            cancel: CancellationToken::new(),
            relays: Vec::new(),
            signals: Some(signals),
            signals_failed: false,
            attempted: false,
            spent: RecordDisposition::Untouched,
            finalized: false,
            cleanup_ceiling: None,
        })
    }
    /// Only the fixed private launch parent is supported. Success is the actual
    /// same-PID exec transition and never returns. An error never retries a
    /// record, exec or relay constructor; owned uncertainty stays in this object.
    pub fn execute_record(&mut self, path: &Path) -> Result<Infallible> {
        if self.attempted {
            return Err(self.error(ChildPhase::Record, ChildCause::Scope));
        }
        self.attempted = true;
        let deadline = Instant::now() + Duration::from_secs(START_SECONDS);
        self.cleanup_ceiling = Some(deadline);
        self.running()?;
        let record = record::consume(path, &self.bootstrap.root).inspect_err(|error| {
            self.spent = error.record_disposition();
        })?;
        self.spent = RecordDisposition::Consumed;
        self.execute(record, deadline)
    }
    /// Native replacement for the fixed tmux wrapper: supervise this same
    /// standalone binary's record mode, publish its exit data, then remain alive.
    /// No caller-selected executable, shell wrapper, output root or host permit.
    pub fn execute_pane(&mut self, path: &Path, exit: &Path) -> Result<Infallible> {
        if self.attempted {
            return Err(self.error(ChildPhase::Record, ChildCause::Scope));
        }
        self.attempted = true;
        self.running()?;
        let name = directory::name(path, &self.bootstrap.root)?;
        let target = directory::name(exit, &self.bootstrap.root)?;
        let Some(stem) = name
            .as_bytes()
            .strip_suffix(b".json")
            .filter(|stem| !stem.is_empty())
        else {
            return Err(self.error(ChildPhase::Record, ChildCause::Scope));
        };
        if [stem, b".exit"].concat() != target.as_bytes() {
            return Err(self.error(ChildPhase::Record, ChildCause::Scope));
        }
        let deadline = Instant::now() + Duration::from_secs(START_SECONDS);
        self.cleanup_ceiling = Some(deadline);
        let program = &self.bootstrap.pane_program;
        let args = [
            OsString::from("reverie-worker-child"),
            path.as_os_str().to_owned(),
        ];
        let environment = std::env::vars_os().collect::<Vec<_>>();
        let prepared = PreparedExec::new(program, &args, &environment)
            .map_err(|cause| self.error(ChildPhase::Execute, ChildCause::Io(cause)))?;
        let mut command = Command::new(program);
        command
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        self.spent = RecordDisposition::Delegated;
        self.relays
            .push(OwnedProcess::begin(command, prepared, deadline));
        self.relays[0]
            .wait_ready(deadline, &self.cancel)
            .map_err(|error| error.at_phase(ChildPhase::Execute).spent(self.spent))?;
        // Constructor is confirmed; user commands intentionally have no runtime
        // timeout. A later stop uses its one first-stop budget, never a refreshed
        // constructor grace or a receipt as cleanup/owner authority.
        self.cleanup_ceiling = None;
        let status = self.wait_pane()?;
        self.relays[0].cleanup(Instant::now())?;
        self.relays.clear();
        self.running()?;
        receipt::publish(exit, &self.bootstrap.root, status)?;
        self.finish_signals(ChildPhase::Receipt)?;
        loop {
            std::thread::park_timeout(Duration::from_secs(60));
        }
    }
    fn wait_pane(&self) -> Result<u8> {
        loop {
            if process::cancelled(&self.cancel) {
                return Err(self.error(ChildPhase::Execute, ChildCause::Cancelled));
            }
            if let Some(status) = self.relays[0]
                .status()
                .map_err(|error| error.at_phase(ChildPhase::Execute).spent(self.spent))?
            {
                return Ok(status);
            }
            process::tick(Instant::now() + Duration::from_millis(50));
        }
    }
    fn execute(&mut self, record: PrivateChildRecord, deadline: Instant) -> Result<Infallible> {
        let inherited = inherited();
        let requested = record
            .requested_environment()
            .map_err(|cause| self.error(ChildPhase::Environment, ChildCause::Data(cause)))?;
        let directory = record
            .directory()
            .map_err(|cause| self.error(ChildPhase::Environment, ChildCause::Data(cause)))?;
        let directory = directory
            .map(|directory| native::python_path(directory.codepoints()))
            .transpose()
            .map_err(|cause| self.error(ChildPhase::Environment, ChildCause::Io(cause)))?;
        let temporary = directory
            .as_ref()
            .map_or_else(TemporaryEnvironmentRoot::global, |directory| {
                project_temporary_root(directory.as_os_str().as_bytes())
            });
        let shim = path_kind(&self.bootstrap.shim, |info| info.is_dir())
            .map_err(|cause| self.error(ChildPhase::Environment, ChildCause::Io(cause)))?;
        let environment = ChildEnvironment::prepare(inherited, requested, &temporary, shim)
            .map_err(|cause| self.error(ChildPhase::Environment, ChildCause::Environment(cause)))?;
        let model = path_kind(&self.bootstrap.model_socket, |info| {
            info.file_type().is_socket()
        })
        .map_err(|cause| self.error(ChildPhase::Relay, ChildCause::Io(cause)))?;
        if model {
            self.relay(true, &environment.for_model_relay(), deadline)?;
        }
        self.relay(false, &environment, deadline)?;
        self.running()?;
        let directory =
            directory.ok_or_else(|| self.error(ChildPhase::Directory, ChildCause::Encoding))?;
        std::env::set_current_dir(&directory)
            .map_err(|cause| self.error(ChildPhase::Directory, ChildCause::Io(cause)))?;
        let command = record
            .command()
            .map_err(|cause| self.error(ChildPhase::Execute, ChildCause::Data(cause)))?;
        let args = vec![
            OsString::from("bash"),
            OsString::from("-c"),
            os(&command).map_err(|cause| self.error(ChildPhase::Execute, ChildCause::Io(cause)))?,
        ];
        let environment = encode_environment(&environment)
            .map_err(|cause| self.error(ChildPhase::Execute, cause))?;
        let prepared = PreparedExec::new(&self.bootstrap.bash, &args, &environment)
            .map_err(|cause| self.error(ChildPhase::Execute, ChildCause::Io(cause)))?;
        // All constructors are now known. Restore inherited/default dispositions
        // before the last stop check: a later kernel SIGTERM kills this process
        // rather than being consumed in a check->exec handler race.
        self.finish_signals(ChildPhase::Execute)?;
        self.running()?;
        prepared
            .execute()
            .map_err(|cause| self.error(ChildPhase::Execute, ChildCause::Io(cause)))
    }
    fn relay(
        &mut self,
        model: bool,
        environment: &ChildEnvironment,
        deadline: Instant,
    ) -> Result<()> {
        self.running()?;
        if self.relays.len() >= 2 {
            return Err(self.error(ChildPhase::Relay, ChildCause::Scope));
        }
        let program = if model {
            &self.bootstrap.model
        } else {
            &self.bootstrap.office
        };
        let argv = OsString::from(if model {
            "/bin/reverie-model-relay"
        } else {
            "/bin/reverie-office-relay"
        });
        let environment = encode_environment(environment)
            .map_err(|cause| self.error(ChildPhase::Relay, cause))?;
        let prepared = PreparedExec::new(program, &[argv], &environment)
            .map_err(|cause| self.error(ChildPhase::Relay, ChildCause::Io(cause)))?;
        let mut command = Command::new(program);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        self.relays
            .push(OwnedProcess::begin(command, prepared, deadline));
        self.relays
            .last()
            .expect("published owned slot before waiting")
            .wait_ready(deadline, &self.cancel)
    }
    fn error(&self, phase: ChildPhase, cause: ChildCause) -> ChildError {
        failure(phase, cause, self.spent)
    }
    fn running(&self) -> Result<()> {
        if process::cancelled(&self.cancel) {
            Err(self.error(ChildPhase::Execute, ChildCause::Cancelled))
        } else {
            Ok(())
        }
    }
    pub fn settle_owned(&mut self, deadline: Instant) -> Result<()> {
        self.cancel.cancel();
        let mut failure: Option<ChildError> = None;
        let deadline = self
            .cleanup_ceiling
            .map_or(deadline, |ceiling| ceiling.min(deadline));
        for relay in &self.relays {
            if let Err(error) = relay.cleanup(child_signals::clamp(deadline)) {
                failure = Some(match failure {
                    None => error,
                    Some(previous) => previous.with_cleanup_from(&error),
                });
            }
        }
        if let Some(error) = failure {
            Err(error)
        } else {
            self.relays.clear();
            Ok(())
        }
    }
    pub fn finish(&mut self, deadline: Instant) -> Result<()> {
        self.settle_owned(deadline)?;
        self.finish_signals(ChildPhase::Execute)?;
        self.finalized = true;
        CAPTURED.store(false, Ordering::Release);
        Ok(())
    }
    fn finish_signals(&mut self, phase: ChildPhase) -> Result<()> {
        if self.signals_failed {
            return Err(self
                .error(phase, ChildCause::Finalization)
                .finalizer(ChildCleanup::Signal));
        }
        if let Some(signals) = self.signals.take()
            && let Err(cause) = signals.finish()
        {
            self.signals_failed = true;
            return Err(self
                .error(phase, ChildCause::Io(cause))
                .finalizer(ChildCleanup::Signal));
        }
        Ok(())
    }
    pub fn termination_signal(&self) -> Option<i32> {
        child_signals::signal()
    }
}
impl Drop for WorkerChildRuntime {
    fn drop(&mut self) {
        self.cancel.cancel();
        if !self.finalized {
            for relay in &self.relays {
                let _ = relay.cleanup(Instant::now());
            }
        }
    }
}
fn inherited() -> Vec<(PythonText, PythonText)> {
    std::env::vars_os()
        .map(|(key, value)| {
            (
                PythonText::try_new(native::python_text(Path::new(&key)))
                    .expect("fsdecode codepoints"),
                PythonText::try_new(native::python_text(Path::new(&value)))
                    .expect("fsdecode codepoints"),
            )
        })
        .collect()
}
fn os(value: &PythonText) -> std::io::Result<OsString> {
    native::python_path(value.codepoints()).map(PathBuf::into_os_string)
}
fn encode_environment(
    environment: &ChildEnvironment,
) -> std::result::Result<Vec<(OsString, OsString)>, ChildCause> {
    environment
        .entries()
        .iter()
        .map(|(key, value)| {
            let ChildEnvironmentValue::Text(value) = value else {
                return Err(ChildCause::Encoding);
            };
            Ok((
                os(key).map_err(ChildCause::Io)?,
                os(value).map_err(ChildCause::Io)?,
            ))
        })
        .collect()
}
fn path_kind(path: &Path, predicate: impl FnOnce(&fs::Metadata) -> bool) -> std::io::Result<bool> {
    match fs::metadata(path) {
        Ok(info) => Ok(predicate(&info)),
        Err(error)
            if [
                Some(libc::ENOENT),
                Some(libc::ENOTDIR),
                Some(libc::EBADF),
                Some(libc::ELOOP),
            ]
            .contains(&error.raw_os_error()) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}
fn failure(phase: ChildPhase, cause: ChildCause, spent: RecordDisposition) -> ChildError {
    ChildError::new(phase, cause).spent(spent)
}
#[cfg(test)]
mod tests;
