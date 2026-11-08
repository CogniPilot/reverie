use clap::ValueEnum;
use reverie_host::worker_service::{WorkerServiceAction, run_native_worker_service};
use std::{
    path::Path,
    time::{Duration, Instant},
};
#[derive(Clone, Copy, ValueEnum)]
pub(super) enum Action {
    Install,
    Start,
    Stop,
    Status,
}
pub(super) fn run(action: Action, config: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let snapshot = reverie_application::worker_validation::load_owner_config(config)?;
    let source = snapshot
        .source_path()
        .ok_or("NATIVE_SERVICE_ORIGINAL_SOURCE_REQUIRED")?;
    let action = match action {
        Action::Install => WorkerServiceAction::Install,
        Action::Start => WorkerServiceAction::Start,
        Action::Stop => WorkerServiceAction::Stop,
        Action::Status => WorkerServiceAction::Status,
    };
    let maximum = if matches!(action, WorkerServiceAction::Stop) {
        45
    } else {
        20
    };
    let end = Instant::now() + Duration::from_secs(maximum);
    match run_native_worker_service(source, action, end) {
        Ok(status) => {
            println!("{status}");
            Ok(())
        }
        Err(owner) => Err(owner),
    }
}
