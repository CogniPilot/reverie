//! Actual selected J identity; no scope, resource or closure is minted here.
use super::*;
use crate::worker_reports::WorkerOriginalHandlersCleanupBinding;

fn close_originals(
    mut owner: WorkerOriginalHandlersDrain,
    mut q: WorkerActorChannel,
    mut original: Published,
    service: &Arc<WorkerReportService>,
    fixture: &Fixture,
) {
    owner.interrupt(&q, service, &fixture.runtime).unwrap();
    owner.settle(&fixture.runtime).unwrap();
    original
        .reconciled
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    original.connection.close_socket(end()).unwrap();
    q.close_for_worker().unwrap();
    original.release.send(()).unwrap();
    service.settle_worker_handlers(end()).unwrap();
    original.hold.release(end()).unwrap();
    assert_eq!(
        owner.settle(&fixture.runtime).unwrap(),
        WorkerHandlersProgress::Settled
    );
    owner.into_closed().ok().unwrap();
    service.close(end()).unwrap();
}

#[test]
fn selected_j_provenance_survives_eof_and_cancel_without_settlement_credit() {
    if isolated(
        "cleanup_binding::selected_j_provenance_survives_eof_and_cancel_without_settlement_credit",
    ) {
        return;
    }
    fn require_send_sync<T: Send + Sync>() {}
    require_send_sync::<WorkerOriginalHandlersCleanupBinding>();
    let fixture = Arc::new(Fixture::new());
    let service = Arc::new(fixture.service());
    let (mut q_client, mut q) = fleet_channel(&fixture, &service);
    let original = published(&fixture, &service);
    let record = service.records.lock().unwrap()[1].clone();
    let mut owner = q
        .retain_other_original_handlers(&service, &fixture.runtime, end())
        .unwrap();
    let binding = owner.cleanup_binding();
    let before = shutdowns();
    let live_owner = binding.assert_owner(&q, &service, &fixture.runtime);
    let live_identity = binding.assert_original(&original.connection, &fixture.runtime);
    let no_effect = shutdowns() == before
        && !record.handler_job().unwrap().unwrap().known_settled()
        && record.require_terminal_hold().is_ok();
    owner.interrupt(&q, &service, &fixture.runtime).unwrap();
    let own_q_uninterrupted = socket_live(&mut q_client);
    original.connection.close_socket(end()).unwrap();
    q.close_for_worker().unwrap();
    fixture.runtime.request_stop();
    let interrupted_count = shutdowns();
    let closed_owner = binding.assert_owner(&q, &service, &fixture.runtime);
    let closed_identity = binding.assert_original(&original.connection, &fixture.runtime);
    let still_unsettled = !record.settled() && record.require_terminal_hold().is_ok();
    let no_more_effect = shutdowns() == interrupted_count;
    close_originals(owner, q, original, &service, &fixture);
    assert!(live_owner.is_ok() && closed_owner.is_ok());
    assert!(live_identity.is_ok() && closed_identity.is_ok());
    assert!(no_effect && no_more_effect && still_unsettled && own_q_uninterrupted);
}

#[test]
fn late_same_sid_and_foreign_service_or_runtime_cannot_join_selected_cleanup() {
    if isolated(
        "cleanup_binding::late_same_sid_and_foreign_service_or_runtime_cannot_join_selected_cleanup",
    ) {
        return;
    }
    let fixture = Arc::new(Fixture::new());
    let other = Fixture::new();
    let service = Arc::new(fixture.service());
    let foreign = Arc::new(fixture.service());
    let foreign_runtime = Arc::new(other.service());
    let (_q_client, q) = fleet_channel(&fixture, &service);
    let original = published(&fixture, &service);
    let owner = q
        .retain_other_original_handlers(&service, &fixture.runtime, end())
        .unwrap();
    let binding = owner.cleanup_binding();
    let (mut other_q_client, mut other_q) = fleet_channel(&fixture, &service);
    let (mut foreign_q_client, mut foreign_q) = fleet_channel(&fixture, &foreign);
    let (mut late_client, late) = super::super::super::launch::launch(&service, &fixture);
    let (mut foreign_client, foreign_j) = super::super::super::launch::launch(&foreign, &fixture);
    let (mut other_client, other_j) = super::super::super::launch::launch(&foreign_runtime, &other);
    let before = shutdowns();
    let own_q = binding.assert_owner(&q, &service, &fixture.runtime);
    let wrong_q = binding.assert_owner(&other_q, &service, &fixture.runtime);
    let wrong_service_q = binding.assert_owner(&foreign_q, &foreign, &fixture.runtime);
    let wrong_service = binding.assert_owner(&q, &foreign, &fixture.runtime);
    let wrong_owner_runtime = binding.assert_owner(&q, &service, &other.runtime);
    let selected = binding.assert_original(&original.connection, &fixture.runtime);
    let wrong_runtime = binding.assert_original(&original.connection, &other.runtime);
    let late_result = binding.assert_original(&late, &fixture.runtime);
    let foreign_result = binding.assert_original(&foreign_j, &fixture.runtime);
    let other_result = binding.assert_original(&other_j, &other.runtime);
    let same_sid = [late.request(), foreign_j.request(), other_j.request()]
        .into_iter()
        .all(|request| request.session() == original.connection.request().session());
    let same_engine_foreign_service = foreign_j.same_runtime(&fixture.runtime);
    let no_effect = shutdowns() == before
        && socket_live(&mut late_client)
        && socket_live(&mut foreign_client)
        && socket_live(&mut other_client)
        && socket_live(&mut other_q_client)
        && socket_live(&mut foreign_q_client);
    late.close(end()).unwrap();
    foreign_j.close(end()).unwrap();
    other_j.close(end()).unwrap();
    other_q.close_for_worker().unwrap();
    foreign_q.close_for_worker().unwrap();
    foreign.close(end()).unwrap();
    foreign_runtime.close(end()).unwrap();
    close_originals(owner, q, original, &service, &fixture);
    assert!(own_q.is_ok() && wrong_q.is_err() && wrong_service_q.is_err());
    assert!(wrong_service.is_err() && wrong_owner_runtime.is_err());
    assert!(selected.is_ok() && same_sid && same_engine_foreign_service && no_effect);
    assert!(wrong_runtime.is_err() && late_result.is_err());
    assert!(foreign_result.is_err() && other_result.is_err());
}
