//! Explicit ordinary-owner bootstrap for the fixed native worker unit. Routine
//! worker operations remain on the registered broker API. Unknown manager or
//! publication outcomes retain the original attempt and its durable marker.
use crate::{
    captured_client::{CancellationToken, CapturedCall, CapturedClient, InstalledCommand, Policy},
    engine_metadata::EngineError,
    native,
};
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
mod failure_fence;
mod run_fence;
pub use run_fence::{NativeServiceRunAttempt, NativeServiceRunFailure, begin_service_run};
mod manager;
mod publication;
pub use failure_fence::{assert_no_service_failure, record_service_failure};
use manager::ObservedUnit;
use publication::environment;
#[cfg(test)]
mod tests;
const UNIT: &str = "reverie-worker-broker.service";
pub enum WorkerServiceAction {
    Install,
    Start,
    Stop,
    Status,
}
#[derive(Debug)]
pub enum WorkerServiceError {
    Refused(&'static str),
    Io(std::io::Error),
    Engine(EngineError),
    Finalization(Box<Self>, Box<Self>),
}
impl std::fmt::Display for WorkerServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(code) => f.write_str(code),
            Self::Io(e) => write!(f, "NATIVE_SERVICE_IO: {e}"),
            Self::Engine(e) => write!(f, "NATIVE_SERVICE_COMMAND: {e}"),
            Self::Finalization(a, b) => write!(f, "{a}; {b}"),
        }
    }
}
impl std::error::Error for WorkerServiceError {}
impl From<std::io::Error> for WorkerServiceError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}
type Result<T> = std::result::Result<T, WorkerServiceError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    value.then_some(()).ok_or(WorkerServiceError::Refused(code))
}
fn finalized<T>(body: Result<T>, close: Result<()>) -> Result<T> {
    match (body, close) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(a), Err(b)) => Err(WorkerServiceError::Finalization(Box::new(a), Box::new(b))),
    }
}
struct State {
    home: PathBuf,
    root: PathBuf,
    source: PathBuf,
    unit: PathBuf,
    previous: Option<PathBuf>,
    client: Arc<CapturedClient>,
    pin: Arc<CapturedClient>,
    pin_call: Option<CapturedCall>,
    call: Option<CapturedCall>,
    files: Vec<File>,
    last: Option<(Vec<u8>, Vec<u8>, u8)>,
    end: Instant,
    attempted: bool,
    uncertain: bool,
    marker: bool,
    pending_identity: Option<(u64, u64)>,
}
/// Contains the original partial installation or command attempt on refusal.
pub struct WorkerServiceFailure {
    owner: Option<Box<State>>,
    primary: WorkerServiceError,
}
impl std::fmt::Debug for WorkerServiceFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerServiceFailure")
            .field("primary", &self.primary)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for WorkerServiceFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.primary.fmt(f)
    }
}
impl std::error::Error for WorkerServiceFailure {}
impl WorkerServiceFailure {
    pub fn primary_error(&self) -> &WorkerServiceError {
        &self.primary
    }
    /// Settle only original admitted native work and opened files. A durable
    /// unknown installation marker is never cleared by local component close.
    pub fn close_components(&mut self) -> Result<()> {
        self.owner.as_mut().map_or(Ok(()), |owner| owner.close())
    }
}
impl Drop for WorkerServiceFailure {
    fn drop(&mut self) {
        std::mem::forget(self.owner.take());
    }
}
/// Called only after the application loaded this exact owner-custodied source.
/// Tool and unit paths are compile-bound package inputs, never CLI choices.
pub fn run_native_worker_service(
    source: &Path,
    action: WorkerServiceAction,
    end: Instant,
) -> std::result::Result<String, Box<WorkerServiceFailure>> {
    let mut state = match State::capture(source, end) {
        Ok(state) => Box::new(state),
        Err(primary) => {
            return Err(Box::new(WorkerServiceFailure {
                owner: None,
                primary,
            }));
        }
    };
    let body = state.run(action);
    let closed = state.close();
    let finished = finalized(body, closed).and_then(|value| {
        if state.marker {
            state.finish_attempt()?;
        }
        Ok(value)
    });
    match finished {
        Ok(value) => Ok(value),
        Err(primary) => Err(Box::new(WorkerServiceFailure {
            owner: Some(state),
            primary,
        })),
    }
}
impl State {
    fn capture(source: &Path, end: Instant) -> Result<Self> {
        need(
            !nix::unistd::geteuid().is_root(),
            "NATIVE_SERVICE_ORDINARY_OWNER_REQUIRED",
        )?;
        let home =
            native::python_path(&native::home_directory(None)?).map_err(WorkerServiceError::Io)?;
        let root = home.join("reverie");
        let source = source.canonicalize()?;
        need(
            source.starts_with(&root),
            "NATIVE_SERVICE_INSTANCE_SOURCE_REQUIRED",
        )?;
        private(&source, false)?;
        let unit = PathBuf::from(
            option_env!("REVERIE_FIXED_NATIVE_WORKER_SERVICE_UNIT").ok_or(
                WorkerServiceError::Refused("NATIVE_SERVICE_PACKAGED_UNIT_REQUIRED"),
            )?,
        );
        immutable(&unit)?;
        let program = PathBuf::from(option_env!("REVERIE_FIXED_NATIVE_WORKER_SYSTEMCTL").ok_or(
            WorkerServiceError::Refused("NATIVE_SERVICE_PACKAGED_SYSTEMCTL_REQUIRED"),
        )?);
        immutable_tool(&program)?;
        let command = InstalledCommand::from_snapshot(
            program.as_os_str(),
            manager_environment(&home),
            home.clone(),
            false,
        )
        .ok_or(WorkerServiceError::Refused(
            "NATIVE_SERVICE_MANAGER_CAPTURE",
        ))?;
        let pin_program =
            PathBuf::from(option_env!("REVERIE_FIXED_NATIVE_WORKER_NIX_STORE").ok_or(
                WorkerServiceError::Refused("NATIVE_SERVICE_PACKAGED_NIX_REQUIRED"),
            )?);
        immutable_tool(&pin_program)?;
        let pin = InstalledCommand::from_snapshot(
            pin_program.as_os_str(),
            std::env::vars_os().collect(),
            home.clone(),
            false,
        )
        .ok_or(WorkerServiceError::Refused("NATIVE_SERVICE_PIN_CAPTURE"))?;
        Ok(Self {
            home,
            root,
            source,
            unit,
            previous: option_env!("REVERIE_FIXED_PREVIOUS_WORKER_SERVICE_UNIT").map(PathBuf::from),
            client: Arc::new(CapturedClient::new(command)),
            pin: Arc::new(CapturedClient::new(pin)),
            pin_call: None,
            call: None,
            files: Vec::new(),
            last: None,
            end: end.min(Instant::now() + Duration::from_secs(20)),
            attempted: false,
            uncertain: false,
            marker: false,
            pending_identity: None,
        })
    }
    fn run(&mut self, action: WorkerServiceAction) -> Result<String> {
        let observed = self.observe()?;
        if matches!(action, WorkerServiceAction::Status) {
            return Ok(format!(
                "{} {} {}",
                observed.load,
                observed.active,
                observed.fragment.display()
            ));
        }
        match action {
            WorkerServiceAction::Install => self.install(observed)?,
            WorkerServiceAction::Start | WorkerServiceAction::Stop => {
                self.assert_installed(&observed)?;
                self.begin_attempt(&action)?;
                self.attempted = true;
                self.command(&[
                    if matches!(action, WorkerServiceAction::Start) {
                        "start"
                    } else {
                        "stop"
                    },
                    UNIT,
                ])?;
                let current = self.observe()?;
                self.assert_installed(&current)?;
                current.require_action_finished(&action)?;
            }
            WorkerServiceAction::Status => unreachable!(),
        }
        Ok("NATIVE_SERVICE_COMMAND_KNOWN; worker/resource readiness is separate".into())
    }
    fn close(&mut self) -> Result<()> {
        let mut result = self
            .client
            .settle_owned(self.end)
            .map_err(|error| WorkerServiceError::Engine(error.into()));
        if let Some(call) = self.call.as_ref() {
            let closed = self
                .client
                .settle_call(call, self.end)
                .map_err(|error| WorkerServiceError::Engine(error.into()));
            if closed.is_ok() {
                self.call = None;
            }
            result = finalized(result, closed);
        }
        result = finalized(
            result,
            self.pin
                .settle_owned(self.end)
                .map_err(|error| WorkerServiceError::Engine(error.into())),
        );
        if let Some(call) = self.pin_call.as_ref() {
            let closed = self
                .pin
                .settle_call(call, self.end)
                .map_err(|error| WorkerServiceError::Engine(error.into()));
            if closed.is_ok() {
                self.pin_call = None;
            }
            result = finalized(result, closed);
        }
        result = finalized(
            result,
            self.pin
                .close(self.end)
                .map_err(|error| WorkerServiceError::Engine(error.into())),
        );
        while let Some(file) = self.files.pop() {
            let closed =
                native::close(file).map_err(|e| WorkerServiceError::Io(std::io::Error::other(e)));
            self.uncertain |= closed.is_err();
            result = finalized(result, closed);
        }
        result = finalized(
            result,
            self.client
                .close(self.end)
                .map_err(|error| WorkerServiceError::Engine(error.into())),
        );
        if self.uncertain {
            result = finalized(
                result,
                Err(WorkerServiceError::Refused(
                    "NATIVE_SERVICE_ORIGINAL_EFFECT_RETAINED",
                )),
            );
        }
        result
    }
}
fn private(path: &Path, directory: bool) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    need(
        m.uid() == nix::unistd::geteuid().as_raw()
            && m.mode() & 0o077 == 0
            && if directory {
                m.is_dir()
            } else {
                m.is_file() && m.nlink() == 1
            },
        "NATIVE_SERVICE_OWNER_CUSTODY",
    )
}
fn immutable(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    need(
        path.starts_with("/nix/store")
            && path.canonicalize()? == path
            && m.is_file()
            && m.uid() == 0
            && m.mode() & 0o222 == 0,
        "NATIVE_SERVICE_PACKAGE_CUSTODY",
    )
}

fn manager_environment(home: &Path) -> Vec<(OsString, OsString)> {
    let uid = nix::unistd::geteuid().as_raw();
    vec![
        ("HOME".into(), home.as_os_str().to_owned()),
        ("LANG".into(), "C.UTF-8".into()),
        ("XDG_RUNTIME_DIR".into(), format!("/run/user/{uid}").into()),
        (
            "DBUS_SESSION_BUS_ADDRESS".into(),
            format!("unix:path=/run/user/{uid}/bus").into(),
        ),
    ]
}

fn immutable_tool(path: &Path) -> Result<()> {
    need(
        path.starts_with("/nix/store"),
        "NATIVE_SERVICE_PACKAGED_TOOL_REQUIRED",
    )?;
    immutable(&path.canonicalize()?)
}

fn pending_bytes(action: &WorkerServiceAction) -> &'static [u8] {
    match action {
        WorkerServiceAction::Install => b"NATIVE_SERVICE_INSTALL_PENDING_V1\n",
        WorkerServiceAction::Start => b"NATIVE_SERVICE_START_PENDING_V1\n",
        WorkerServiceAction::Stop => b"NATIVE_SERVICE_STOP_PENDING_V1\n",
        WorkerServiceAction::Status => b"NATIVE_SERVICE_READONLY_V1\n",
    }
}
