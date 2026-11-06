//! Actual optional host telemetry sink and engine/mount isolation boundary.
//! The installed service captures one genuine Runtime origin. This is neither
//! proof of execution nor an owner/launch grant; create still needs admission.
mod error;
mod records;
mod reports;
#[cfg(test)]
mod tests;
use crate::{
    engine_metadata::EngineQuery, installed_worker_engine::InstalledWorkerEngine, native,
    worker_runtime::WorkerRuntime, worker_storage,
};
use error::Result;
pub use error::TelemetryError;
pub use reports::EmployeeReport;
use reverie_contracts::{
    command_telemetry::{self, TelemetryDataError, TelemetrySource},
    storage_identity::MetadataText,
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::{PythonText, command_telemetry::TelemetryConfiguration, posix_path::PosixPath};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
pub struct CommandTelemetry {
    config: EffectiveWorkerConfig,
    policy: TelemetryConfiguration,
    engine: Arc<InstalledWorkerEngine>,
    root: Option<PosixPath>,
    uid: u32,
    producer: Mutex<()>,
    reports: Mutex<()>,
    logs: reverie_store::command_failures::LearningLogs,
}
impl CommandTelemetry {
    /// Source constructor order: optional config; UID/state; all configured and
    /// legacy sources; fixed engine census/inspect; only then create the sink.
    /// Failure retains the service's shared pending engine owner in Runtime.
    pub fn capture(runtime: &WorkerRuntime, config: &EffectiveWorkerConfig) -> Result<Self> {
        let mut this = Self {
            config: config.clone(),
            policy: command_telemetry::configuration(config)?,
            engine: Arc::clone(runtime.installed_engine()),
            root: None,
            uid: 0, // unused until the actual enabled branch below
            producer: Mutex::new(()),
            reports: Mutex::new(()),
            logs: reverie_store::command_failures::LearningLogs::new(),
        };
        if !this.policy.enabled() {
            return Ok(this);
        }
        this.uid = native::uid();
        let data = TelemetrySource::capture(config);
        if !data.uid_matches(this.uid)? {
            return Err(TelemetryDataError::Boundary.into());
        }
        let state = worker_storage::canonical_posix(&data.state_root()?)?;
        let path = native::python_path(&state.codepoints())?;
        worker_storage::telemetry_directory(&path, this.uid, false)?;
        this.root = Some(state.join(&PosixPath::from_scalar_text("command-telemetry")));
        let sources = data.configured_sources(&state)?;
        let legacy = legacy_sources(&state, &path)?;
        this.check_sources(
            sources
                .into_iter()
                .map(|source| source.into_path())
                .chain(legacy.into_iter().map(Ok)),
        )?;
        this.check_existing()?;
        worker_storage::telemetry_directory(
            &native::python_path(&this.sink()?.codepoints())?,
            this.uid,
            true,
        )?;
        Ok(this)
    }
    pub fn enabled(&self) -> bool {
        self.policy.enabled()
    }
    pub fn keys(&self) -> &[reverie_core::worker_options::TelemetryKey] {
        self.policy.keys()
    }
    pub(crate) fn assert_runtime(&self, runtime: &WorkerRuntime) -> Result<()> {
        if Arc::ptr_eq(&self.engine, runtime.installed_engine()) {
            Ok(())
        } else {
            Err(TelemetryError::Runtime)
        }
    }
    fn sink(&self) -> Result<&PosixPath> {
        self.root
            .as_ref()
            .ok_or(TelemetryDataError::Boundary.into())
    }
    fn check_sources(
        &self,
        sources: impl IntoIterator<Item = std::result::Result<MetadataText, TelemetryDataError>>,
    ) -> Result<()> {
        if !self.enabled() {
            return Ok(());
        }
        let sink = worker_storage::canonical_posix(&path_text(self.sink()?))?;
        for source in sources {
            if sink.overlaps(&worker_storage::canonical_posix(&source?)?) {
                return Err(TelemetryDataError::Boundary.into());
            }
        }
        Ok(())
    }
    fn query(&self, query: EngineQuery<'_>) -> Result<String> {
        let deadline =
            Instant::now() + Duration::from_secs(crate::engine_metadata::MAX_QUERY_SECONDS);
        let deadline = self
            .engine
            .stop_deadline()
            .map_or(deadline, |stop| stop.min(deadline));
        Ok(self
            .engine
            .readonly()
            .query(query, deadline, &self.engine.cancellation())?)
    }
    fn check_existing(&self) -> Result<()> {
        let ids = command_telemetry::inventory_ids(&self.query(EngineQuery::TelemetryInventory)?)?;
        for id in ids {
            let sources = command_telemetry::inspect_sources(
                &self.query(EngineQuery::TelemetryInspect(&id))?,
            )?;
            self.check_sources(sources.into_iter().map(Ok))?;
        }
        Ok(())
    }
    /// The complete final create argv, including account/Nix mounts, must reach
    /// this check immediately before the installing caller's actual create.
    pub fn check_create_args(&self, runtime: &WorkerRuntime, args: &[MetadataText]) -> Result<()> {
        self.assert_runtime(runtime)?;
        if !self.enabled() {
            return Ok(());
        }
        self.check_sources(command_telemetry::create_sources(args)?.into_iter().map(Ok))
    }
}
fn path_text(value: &PosixPath) -> MetadataText {
    MetadataText::from_python_text(PythonText::try_new(value.codepoints()).expect("checked path"))
}

fn legacy_sources(state: &PosixPath, path: &std::path::Path) -> Result<Vec<MetadataText>> {
    let mut sources = Vec::new();
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let name = native::python_text(std::path::Path::new(&entry.file_name()));
        if name.len() != 36
            || !name
                .iter()
                .all(|&cp| cp == 45 || (48..=57).contains(&cp) || (97..=102).contains(&cp))
        {
            continue;
        }
        let legacy = state.join(&PosixPath::try_new(&name).expect("filesystem Python text"));
        for leaf in ["home", "nix"] {
            sources.push(path_text(&legacy.join(&PosixPath::from_scalar_text(leaf))))
        }
    }
    Ok(sources)
}
