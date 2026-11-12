use clap::ValueEnum;
use reverie_host::worker_service::{
    NativeWorkerServiceRole, WorkerServiceAction, run_native_worker_service_for_role,
};
use std::{
    path::Path,
    time::{Duration, Instant},
};
#[derive(Clone, Copy, ValueEnum)]
pub(super) enum Action {
    Install,
    Start,
    Stop,
    /// Drain actual original viewers/laptops, then stop the same service.
    QuiesceStop,
    Status,
    Rollback,
    Upgrade,
}
#[derive(Clone, Copy, Default, ValueEnum)]
pub(super) enum Role {
    #[default]
    Broker,
    OfferPoolV1,
}
impl From<Role> for NativeWorkerServiceRole {
    fn from(role: Role) -> Self {
        match role {
            Role::Broker => Self::Broker,
            Role::OfferPoolV1 => Self::PoolOfferV1,
        }
    }
}
pub(super) fn run(
    action: Action,
    config: &Path,
    start_previous: bool,
    restart: bool,
    force_stopped: bool,
    role: Role,
) -> Result<(), Box<dyn std::error::Error>> {
    if start_previous && !matches!(action, Action::Rollback) {
        return Err("NATIVE_SERVICE_START_PREVIOUS_ONLY_DURING_ROLLBACK".into());
    }
    if (restart || force_stopped) && !matches!(action, Action::Upgrade) {
        return Err("NATIVE_SERVICE_UPGRADE_FLAGS_REQUIRE_UPGRADE".into());
    }
    let snapshot = reverie_application::worker_validation::load_owner_config(config)?;
    let source = snapshot
        .source_path()
        .ok_or("NATIVE_SERVICE_ORIGINAL_SOURCE_REQUIRED")?;
    let action = match action {
        Action::Install => WorkerServiceAction::Install,
        Action::Start => WorkerServiceAction::Start,
        Action::Stop => WorkerServiceAction::Stop,
        Action::QuiesceStop => WorkerServiceAction::QuiesceStop,
        Action::Status => WorkerServiceAction::Status,
        Action::Rollback => WorkerServiceAction::Rollback { start_previous },
        Action::Upgrade => WorkerServiceAction::Upgrade { force_stopped },
    };
    let maximum = match action {
        WorkerServiceAction::Upgrade { .. } => 90,
        WorkerServiceAction::Stop => 45,
        WorkerServiceAction::QuiesceStop => 180,
        _ => 20,
    };
    let end = Instant::now() + Duration::from_secs(maximum);
    match run_native_worker_service_for_role(source, action, role.into(), end) {
        Ok(status) => {
            if restart {
                let current = reverie_application::worker_validation::load_owner_config(source)?;
                if !reverie_contracts::worker_config::equivalent(
                    snapshot.configuration(),
                    current.configuration(),
                ) {
                    return Err("NATIVE_SERVICE_RESTART_SOURCE_CHANGED".into());
                }
                run_native_worker_service_for_role(
                    source,
                    WorkerServiceAction::Start,
                    role.into(),
                    Instant::now() + Duration::from_secs(20),
                )?;
            }
            println!("{status}");
            Ok(())
        }
        Err(owner) => Err(owner),
    }
}
