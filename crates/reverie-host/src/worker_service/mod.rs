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
mod command;
mod manager;
mod quiesce;
pub use quiesce::{DeploymentServiceQuiesceFailure, quiesce_stopped_worker_service};
mod publication;
mod rollback;
mod stopped;
mod upgrade;
pub use failure_fence::{assert_no_service_failure, record_service_failure};
use manager::ObservedUnit;
use publication::environment;
pub use reverie_contracts::worker_service::NativeWorkerServiceRole;
pub use stopped::{
    ClosedImageServiceMaintenance, ClosedStoppedWorkerService, ImageServiceMaintenance,
    StoppedServiceFailure, StoppedServiceOrigin, StoppedWorkerService,
    capture_stopped_worker_service, capture_stopped_worker_service_for_role,
};
#[cfg(test)]
mod tests;
const UNIT: &str = "reverie-worker-broker.service";
pub enum WorkerServiceAction {
    Install,
    Start,
    Stop,
    QuiesceStop,
    Status,
    Rollback { start_previous: bool },
    Upgrade { force_stopped: bool },
}
#[derive(Debug)]
pub enum WorkerServiceError {
    Refused(&'static str),
    Io(std::io::Error),
    Engine(EngineError),
    Program(&'static str),
    Control(Arc<reverie_worker_client::ControlError>),
    Configuration(reverie_contracts::worker_config::WorkerConfigError),
    Schema(reverie_contracts::worker_schema::WorkerSchemaError),
    Finalization(Box<Self>, Box<Self>),
}
impl WorkerServiceError {
    /// Stable diagnostic classification; the original typed cause is retained.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) | Self::Program(code) => code,
            Self::Io(_) => "NATIVE_SERVICE_IO",
            Self::Engine(error) => error.code(),
            Self::Control(_) => "NATIVE_SERVICE_QUIESCE",
            Self::Configuration(error) => error.code(),
            Self::Schema(_) => "NATIVE_SERVICE_CONFIGURATION_SCHEMA",
            Self::Finalization(primary, _) => primary.code(),
        }
    }
}
impl std::fmt::Display for WorkerServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(code) => f.write_str(code),
            Self::Io(e) => write!(f, "NATIVE_SERVICE_IO: {e}"),
            Self::Engine(e) => write!(f, "NATIVE_SERVICE_COMMAND: {e}"),
            Self::Program(code) => write!(f, "NATIVE_SERVICE_PROGRAM: {code}"),
            Self::Control(error) => write!(f, "NATIVE_SERVICE_QUIESCE: {error}"),
            Self::Configuration(error) => error.fmt(f),
            Self::Schema(error) => error.fmt(f),
            Self::Finalization(a, b) => write!(f, "{a}; {b}"),
        }
    }
}
impl std::error::Error for WorkerServiceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Control(e) => Some(e.as_ref()),
            Self::Configuration(e) => Some(e),
            Self::Schema(e) => Some(e),
            Self::Finalization(primary, _) => Some(primary.as_ref()),
            _ => None,
        }
    }
}
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
    upgrade_bus: Option<stopped::bus::BusReader>,
    upgrade_inputs: crate::website_facts::ImmutableInputObserver,
    upgrade_failure: Option<Box<crate::website_facts::WebsiteFactsError>>,
    upgrade_close_failure: Option<Box<crate::website_facts::WebsiteFactsError>>,
    checked_generation: Option<upgrade::CheckedNativeGeneration>,
    stop_takeover: Option<upgrade::StopPendingTakeover>,
    quiescence_failure: Option<Arc<reverie_worker_client::ControlError>>,
}
/// Closed construction budgets. The long deployment owner is never obtained
/// by extending an already captured Status/image/PERF observation.
enum CapturePurpose<'a> {
    Command(&'a WorkerServiceAction),
    DeploymentMaintenance,
}
impl CapturePurpose<'_> {
    fn maximum(&self) -> Duration {
        Duration::from_secs(match self {
            Self::DeploymentMaintenance => 900,
            Self::Command(WorkerServiceAction::Upgrade { .. }) => 90,
            Self::Command(WorkerServiceAction::Stop) => 45,
            Self::Command(WorkerServiceAction::QuiesceStop) => 180,
            Self::Command(_) => 20,
        })
    }
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
impl std::error::Error for WorkerServiceFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.program_error()
            .or_else(|| self.program_close_error())
            .map(|e| e as &(dyn std::error::Error + 'static))
            .or(Some(&self.primary))
    }
}
impl WorkerServiceFailure {
    pub fn primary_error(&self) -> &WorkerServiceError {
        &self.primary
    }
    pub fn program_error(&self) -> Option<&crate::website_facts::WebsiteFactsError> {
        self.owner
            .as_ref()
            .and_then(|o| o.upgrade_failure.as_deref())
    }
    pub fn program_close_error(&self) -> Option<&crate::website_facts::WebsiteFactsError> {
        self.owner
            .as_ref()
            .and_then(|o| o.upgrade_close_failure.as_deref())
    }
    pub fn stop_takeover_error(&self) -> Option<&crate::worker_image::ImageFileError> {
        self.owner
            .as_ref()
            .and_then(|owner| owner.stop_takeover.as_ref())
            .and_then(upgrade::StopPendingTakeover::error)
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
    run_native_worker_service_for_role(source, action, NativeWorkerServiceRole::Broker, end)
}
/// Same original installation/upgrade owners, with only the two packaged roles.
pub fn run_native_worker_service_for_role(
    source: &Path,
    action: WorkerServiceAction,
    role: NativeWorkerServiceRole,
    end: Instant,
) -> std::result::Result<String, Box<WorkerServiceFailure>> {
    let mut state = match State::capture_for_role(source, end, &action, role) {
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
    fn capture(source: &Path, end: Instant, action: &WorkerServiceAction) -> Result<Self> {
        Self::capture_for_role(source, end, action, NativeWorkerServiceRole::Broker)
    }
    fn capture_for_role(
        source: &Path,
        end: Instant,
        action: &WorkerServiceAction,
        role: NativeWorkerServiceRole,
    ) -> Result<Self> {
        Self::capture_purpose(source, end, CapturePurpose::Command(action), role)
    }
    fn capture_deployment_maintenance(
        source: &Path,
        end: Instant,
        role: NativeWorkerServiceRole,
    ) -> Result<Self> {
        Self::capture_purpose(source, end, CapturePurpose::DeploymentMaintenance, role)
    }
    fn capture_purpose(
        source: &Path,
        end: Instant,
        purpose: CapturePurpose<'_>,
        role: NativeWorkerServiceRole,
    ) -> Result<Self> {
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
        let unit = packaged_role_unit(role)?;
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
            manager_environment(&home),
            home.clone(),
            false,
        )
        .ok_or(WorkerServiceError::Refused("NATIVE_SERVICE_PIN_CAPTURE"))?;
        let previous = option_env!("REVERIE_FIXED_PREVIOUS_WORKER_SERVICE_UNIT").map(PathBuf::from);
        if let Some(path) = previous.as_ref() {
            immutable(path)?;
        }
        Ok(Self {
            home,
            root,
            source,
            unit,
            previous,
            client: Arc::new(CapturedClient::new(command)),
            pin: Arc::new(CapturedClient::new(pin)),
            pin_call: None,
            call: None,
            files: Vec::new(),
            last: None,
            end: end.min(Instant::now() + purpose.maximum()),
            attempted: false,
            uncertain: false,
            marker: false,
            pending_identity: None,
            upgrade_bus: None,
            upgrade_inputs: Default::default(),
            upgrade_failure: None,
            upgrade_close_failure: None,
            checked_generation: None,
            stop_takeover: None,
            quiescence_failure: None,
        })
    }
    fn run(&mut self, action: WorkerServiceAction) -> Result<String> {
        match action {
            WorkerServiceAction::Upgrade { .. } => self.prepare_recorded_generation()?,
            WorkerServiceAction::Status => {
                match fs::symlink_metadata(self.folder().join("native-package")) {
                    Ok(_) => self.prepare_recorded_generation()?,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            _ => {}
        }
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
            WorkerServiceAction::Upgrade { force_stopped } => {
                self.upgrade(observed, force_stopped)?
            }
            WorkerServiceAction::Rollback { start_previous } => {
                self.rollback(observed, start_previous)?
            }
            WorkerServiceAction::Start
            | WorkerServiceAction::Stop
            | WorkerServiceAction::QuiesceStop => {
                self.run_service_command(&action, observed)?;
            }
            WorkerServiceAction::Status => unreachable!(),
        }
        Ok("NATIVE_SERVICE_COMMAND_KNOWN; worker/resource readiness is separate".into())
    }
    fn close_metadata(&mut self) -> Result<()> {
        let mut result = Ok(());
        while let Some(file) = self.files.pop() {
            let closed =
                native::close(file).map_err(|e| WorkerServiceError::Io(std::io::Error::other(e)));
            self.uncertain |= closed.is_err();
            result = finalized(result, closed);
        }
        result
    }
    fn close(&mut self) -> Result<()> {
        let mut result = self
            .client
            .settle_owned(self.end)
            .map_err(|error| WorkerServiceError::Engine(error.into()));
        if let Some(bus) = &mut self.upgrade_bus {
            result = finalized(result, bus.close());
        }
        let input_close = if let Some(error) = &self.upgrade_close_failure {
            Err(WorkerServiceError::Program(error.code()))
        } else {
            self.upgrade_inputs.assert_finalized().map_err(|error| {
                let code = error.code();
                self.upgrade_close_failure = Some(Box::new(error));
                WorkerServiceError::Program(code)
            })
        };
        result = finalized(result, input_close);
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
        result = finalized(result, self.close_metadata());
        result = finalized(
            result,
            self.client
                .close(self.end)
                .map_err(|error| WorkerServiceError::Engine(error.into())),
        );
        if let Some(owner) = &mut self.stop_takeover {
            result = finalized(result, owner.close());
        }
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
fn packaged_role_unit(role: NativeWorkerServiceRole) -> Result<PathBuf> {
    let selected = match role {
        NativeWorkerServiceRole::Broker => option_env!("REVERIE_FIXED_NATIVE_WORKER_SERVICE_UNIT"),
        NativeWorkerServiceRole::PoolOfferV1 => {
            option_env!("REVERIE_FIXED_NATIVE_POOL_OFFER_SERVICE_UNIT")
        }
    };
    let unit = PathBuf::from(selected.ok_or(WorkerServiceError::Refused(
        "NATIVE_SERVICE_PACKAGED_UNIT_REQUIRED",
    ))?);
    immutable(&unit)?;
    Ok(unit)
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
        WorkerServiceAction::Stop | WorkerServiceAction::QuiesceStop => {
            b"NATIVE_SERVICE_STOP_PENDING_V1\n"
        }
        WorkerServiceAction::Status => b"NATIVE_SERVICE_READONLY_V1\n",
        WorkerServiceAction::Rollback { .. } => b"NATIVE_SERVICE_ROLLBACK_PENDING_V1\n",
        WorkerServiceAction::Upgrade { .. } => b"NATIVE_SERVICE_UPGRADE_PENDING_V1\n",
    }
}
