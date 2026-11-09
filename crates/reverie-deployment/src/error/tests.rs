use super::*;
use std::error::Error;

fn snapshot_error(marker: &'static str) -> SnapshotError {
    SnapshotError::from(io::Error::other(marker))
}
fn private_message(error: &DeploymentError) -> String {
    error
        .snapshot_error()
        .unwrap()
        .source()
        .unwrap()
        .to_string()
}

#[test]
fn original_snapshot_error_survives_without_exposing_its_private_message() {
    let error = DeploymentError::snapshot(
        "DEPLOYMENT_SNAPSHOT_REFUSED",
        snapshot_error("PRIVATE_PRIMARY_TOKEN_AND_PATH"),
    );
    assert_eq!(error.code(), "DEPLOYMENT_SNAPSHOT_REFUSED");
    assert_eq!(error.snapshot_error().unwrap().code(), "SNAPSHOT_IO");
    assert_eq!(private_message(&error), "PRIVATE_PRIMARY_TOKEN_AND_PATH");
    assert!(
        error
            .source()
            .unwrap()
            .downcast_ref::<SnapshotError>()
            .is_some()
    );
    let diagnostic = error.diagnostic();
    assert_eq!(diagnostic["error"]["snapshot"]["code"], "SNAPSHOT_IO");
    assert!(!diagnostic.to_string().contains("PRIVATE_"));
    assert!(!format!("{error:?}").contains("PRIVATE_"));
}

#[test]
fn whole_nested_snapshot_and_outer_finalizers_survive_in_order() {
    let cleanup = DeploymentError::finalized::<()>(
        Err(DeploymentError::snapshot(
            "DEPLOYMENT_SNAPSHOT_CLOSE_UNCONFIRMED",
            snapshot_error("PRIVATE_CLEANUP"),
        )),
        Err(DeploymentError::new("TEST_ARCHIVE_CLOSE_UNCONFIRMED")),
    )
    .unwrap_err();
    let primary = DeploymentError::snapshot(
        "DEPLOYMENT_SNAPSHOT_REFUSED",
        snapshot_error("PRIVATE_PRIMARY"),
    );
    let error = DeploymentError::finalized::<()>(Err(primary), Err(cleanup)).unwrap_err();
    let error = DeploymentError::finalized::<()>(
        Err(error),
        Err(DeploymentError::new("TEST_SERVICE_CLOSE_UNCONFIRMED")),
    )
    .unwrap_err();
    assert_eq!(
        error.finalization_code(),
        Some("TEST_SERVICE_CLOSE_UNCONFIRMED")
    );
    assert_eq!(error.finalization_errors().len(), 2);
    assert_eq!(private_message(&error), "PRIVATE_PRIMARY");
    let close = &error.finalization_errors()[0];
    assert_eq!(private_message(close), "PRIVATE_CLEANUP");
    assert_eq!(
        close.finalization_errors()[0].code(),
        "TEST_ARCHIVE_CLOSE_UNCONFIRMED"
    );
    let diagnostic = error.diagnostic();
    assert_eq!(
        diagnostic["error"]["finalization"][0]["snapshot"]["code"],
        "SNAPSHOT_IO"
    );
    assert_eq!(
        diagnostic["error"]["finalization"][0]["finalization"][0]["code"],
        "TEST_ARCHIVE_CLOSE_UNCONFIRMED"
    );
    assert_eq!(
        diagnostic["error"]["finalization"][1]["code"],
        "TEST_SERVICE_CLOSE_UNCONFIRMED"
    );
    assert!(!diagnostic.to_string().contains("PRIVATE_"));
}

#[test]
fn safe_projection_is_bounded_while_the_original_typed_failures_remain_retained() {
    let mut error = DeploymentError::snapshot(
        "DEPLOYMENT_SNAPSHOT_REFUSED",
        snapshot_error("PRIVATE_PRIMARY"),
    );
    for _ in 0..100 {
        error = DeploymentError::finalized::<()>(
            Err(error),
            Err(DeploymentError::new("TEST_CLOSE_UNCONFIRMED")),
        )
        .unwrap_err();
    }
    assert_eq!(error.finalization_errors().len(), 100);
    let diagnostic = error.diagnostic();
    assert_eq!(diagnostic["truncated"], true);
    assert!(diagnostic.to_string().len() < 16_384);
    assert!(!diagnostic.to_string().contains("PRIVATE_"));
}
