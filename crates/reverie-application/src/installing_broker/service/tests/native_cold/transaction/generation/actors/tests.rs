//! Error DATA classifiers never establish ownership or native closure.
use super::*;
use reverie_host::{worker_laptop::LaptopError, worker_runtime::RuntimeError};

fn residual() -> LaptopError {
    LaptopError::Refused("WORKER_LAPTOP_RETAINED")
}
fn pair(primary: LaptopError, secondary: LaptopError) -> LaptopError {
    LaptopError::Finalization {
        primary: Box::new(primary),
        secondary: Box::new(secondary),
    }
}
fn service(error: RuntimeError) -> BrokerServiceError {
    BrokerServiceError::Shutdown(vec![
        BrokerServiceError::Recovery(crate::installing_broker::RecoveryError::Refused(
            "WORKER_SERVICE_STORAGE_RETAINED",
        )),
        BrokerServiceError::Runtime(error),
    ])
}

#[test]
fn exact_residual_tree_allows_only_a_quarantined_fresh_recovery_attempt() {
    let error = service(RuntimeError::Laptop(pair(
        residual(),
        pair(residual(), residual()),
    )));
    assert!(quarantinable_service_failure(&error));
}

#[test]
fn quarantine_refuses_empty_mixed_other_and_lookalike_failures() {
    assert!(!quarantinable_service_failure(
        &BrokerServiceError::Shutdown(vec![])
    ));
    for error in [
        LaptopError::Refused("WORKER_LAPTOP_EFFECT_UNCONFIRMED"),
        pair(residual(), LaptopError::Refused("WORKER_OTHER")),
        pair(LaptopError::Refused("WORKER_OTHER"), residual()),
        LaptopError::Io(std::io::Error::other("WORKER_LAPTOP_RETAINED")),
        LaptopError::Recorded(Arc::new(residual())),
    ] {
        assert!(!quarantinable_service_failure(&service(
            RuntimeError::Laptop(error)
        )));
    }
    assert!(!quarantinable_service_failure(&service(
        RuntimeError::Finalization {
            primary: Box::new(RuntimeError::Laptop(residual())),
            secondary: Box::new(RuntimeError::Laptop(residual())),
        }
    )));
    assert!(!quarantinable_service_failure(
        &BrokerServiceError::Handler(reverie_host::worker_reports::WorkerReportError::Unconfirmed,)
    ));
}

#[test]
fn quarantine_rejects_actual_foreign_engine_identity_and_nix_retention() {
    use reverie_host::engine_metadata::{EngineBootstrap, ReadonlyEngine};
    let context = || {
        ReadonlyEngine::new(
            EngineBootstrap::from_service(
                std::env::current_exe().unwrap().as_os_str(),
                BTreeMap::new(),
                std::env::current_dir().unwrap(),
            )
            .unwrap(),
        )
    };
    let first = context();
    let second = context();
    let owner = first.capture_query_owner();
    let error = owner.assert_engine(&second).unwrap_err();
    assert!(!quarantinable_service_failure(&service(
        RuntimeError::Engine(error)
    )));
    assert!(!quarantinable_service_failure(&service(RuntimeError::Nix(
        reverie_host::worker_nix::NixError::Refused(reverie_host::worker_nix::NixFault::Retained),
    ))));
    owner.settle_owned(Instant::now()).unwrap();
    let end = Instant::now() + Duration::from_secs(1);
    first.close(end).unwrap();
    second.close(end).unwrap();
}
