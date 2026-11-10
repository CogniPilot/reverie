//! Lower-owner regression only: one actual ordinary file and the existing
//! consumed-close fault. No controller, policy grant, cgroup or container.
use super::*;
use crate::{ObservationError, ObservationFault, native};
#[test]
fn website_close_classification_uses_typed_origin_not_matching_text() {
    use crate::website_facts::WebsiteFactsError;
    let actual = PoolError::BootstrapFacts(Box::new(WebsiteFactsError::DescriptorClose));
    let lookalike = PoolError::BootstrapFacts(Box::new(WebsiteFactsError::Refused(
        "BACKEND_CODE_CLOSE_UNCONFIRMED",
    )));
    assert_eq!(
        actual.code(),
        lookalike.code(),
        "public code compatibility is preserved"
    );
    assert!(actual.has_unconfirmed_close());
    assert!(!lookalike.has_unconfirmed_close());
    let nested = PoolError::BootstrapFacts(Box::new(WebsiteFactsError::Finalization {
        primary: Box::new(WebsiteFactsError::Refused("BODY_REFUSED")),
        secondary: Box::new(WebsiteFactsError::DescriptorClose),
    }));
    assert!(nested.has_unconfirmed_close());
}
#[test]
fn actual_consumed_observation_close_remains_opaque_through_pool_error() {
    let path = std::env::temp_dir().join(format!(
        "pool-close-classifier-{}-{}",
        std::process::id(),
        crate::resource_facts::fresh_owner_nonce().unwrap().as_str()
    ));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    native::test_faults::set(None, true);
    let cause = native::close(file).unwrap_err();
    assert!(cause.has_unconfirmed_close());
    let failure = crate::observation::finalized::<()>(
        Err(ObservationError::Refused(ObservationFault::Changed)),
        Err(cause),
    )
    .unwrap_err();
    let pooled = PoolError::from(failure);
    std::fs::remove_file(path).unwrap();
    assert!(pooled.close_unknown());
    assert!(
        !PoolError::from(ObservationError::Io(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied
        )))
        .close_unknown()
    );
    assert!(
        !PoolError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied)).close_unknown()
    );
}
