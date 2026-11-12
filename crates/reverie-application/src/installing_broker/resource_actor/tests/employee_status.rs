//! Typed negative closure composition with a real accepted Q/peer/record.
//! Native FD-close production is tested by Host; no successful origin is forged.
use super::*;
#[derive(Debug)]
struct RetainedWitness(Arc<()>);
impl std::fmt::Display for RetainedWitness {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            output,
            "typed close witness ({})",
            Arc::strong_count(&self.0)
        )
    }
}
impl std::error::Error for RetainedWitness {}
#[test]
fn employee_status_unchecked_drop_keeps_original_typed_close_cause() {
    crate::test_process::owning_case!(
        employee_status_unchecked_drop_keeps_original_typed_close_cause
    );
    let mut fixture = Fixture::new();
    fixture.retained = true;
    let (mut client, connection) = fixture.accept(b'Q', b"{}");
    let mut failure = fixture
        .broker
        .prepare_resource_website(connection)
        .err()
        .unwrap();
    let original = Arc::new(());
    let weak = Arc::downgrade(&original);
    let cause = reverie_host::worker_pool::PoolError::MetadataClose(Box::new(
        reverie_host::worker_pool::PoolError::Io(std::io::Error::other(RetainedWitness(original))),
    ));
    assert!(
        failure
            .frame
            .retain_stateless_result::<()>(Err(ResourceActorError::Controller(Box::new(cause))))
            .unwrap_err()
            .has_unconfirmed_close()
    );
    assert!(
        failure
            .close_channel_component(end())
            .unwrap_err()
            .has_unconfirmed_close()
    );
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    drop(failure);
    assert!(
        weak.upgrade().is_some(),
        "unchecked Drop must retain the SAME typed close cause with the Q owner"
    );
}
#[test]
fn employee_status_close_unknown_keeps_same_q_scope_after_disconnect() {
    crate::test_process::owning_case!(
        employee_status_close_unknown_keeps_same_q_scope_after_disconnect
    );
    let mut fixture = Fixture::new();
    fixture.retained = true;
    let (mut client, connection) = fixture.accept(b'Q', b"{}");
    let mut failure = fixture
        .broker
        .prepare_resource_website(connection)
        .err()
        .unwrap();
    let cause = reverie_host::worker_pool::PoolError::MetadataClose(Box::new(
        reverie_host::worker_pool::PoolError::Io(std::io::Error::other(
            "typed consumed-close witness",
        )),
    ));
    let body = failure
        .frame
        .retain_stateless_result::<()>(Err(ResourceActorError::Controller(Box::new(cause))));
    assert!(body.unwrap_err().has_unconfirmed_close());
    let original = std::ptr::from_ref(failure.frame.employee_close.as_deref().unwrap());
    for _ in 0..3 {
        assert!(
            failure
                .close_channel_component(end())
                .unwrap_err()
                .has_unconfirmed_close()
        );
        assert!(std::ptr::eq(
            original,
            failure.frame.employee_close.as_deref().unwrap()
        ));
    }
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert!(
        failure.frame.unconfirmed.is_none(),
        "only this typed employee scope is retained"
    );
}
