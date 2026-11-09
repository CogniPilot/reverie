//! Actual L Record/hold/socket/pidfd controls, never program or Q authority.
use super::*;
use std::{error::Error, os::fd::AsRawFd};
const BODY: &[u8] = br#"{"reference":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","request":{"sessionId":"00000000-0000-0000-0000-000000000000","cwd":"/work","command":"echo hello","env":{},"cols":80,"rows":24}}"#;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_reports::tests::protected_peer::{name}"))
}
struct Owned {
    fixture: Option<Fixture>,
    service: Arc<WorkerReportService>,
    client: Option<UnixStream>,
    held: Option<HeldProtectedWorkerLaunch>,
    connection: Option<Arc<WorkerLaunchConnection>>,
    hold: Option<WorkerLaunchHold>,
    direct: Option<WorkerServiceConnection>,
    incoming: Option<WorkerProtectedLaunchConnection>,
    pin: Option<ProtectedLaunchPeerPin>,
    failed_pin: Option<Box<ProtectedLaunchPeerFailure>>,
    finished: bool,
}
impl Owned {
    fn new() -> Self {
        let fixture = Fixture::new();
        let service = Arc::new(fixture.service());
        Self {
            fixture: Some(fixture),
            service,
            client: None,
            held: None,
            connection: None,
            hold: None,
            direct: None,
            incoming: None,
            pin: None,
            failed_pin: None,
            finished: false,
        }
    }
    fn receive(&mut self) -> Result<()> {
        let fixture = self.fixture.as_ref().unwrap();
        let (client, server) = fixture.sockets();
        self.client = Some(client);
        send(self.client.as_mut().unwrap(), b'L', BODY);
        let accepted = self
            .service
            .register_worker_connection(server)?
            .receive_service_for_worker(&fixture.collector, &super::launch::configuration())?;
        let AcceptedWorkerServiceConnection::Service(source) = accepted else {
            return Err(WorkerReportError::LaunchKind);
        };
        let incoming = match source.decode_protected_launch(&super::launch::configuration()) {
            Ok(incoming) => incoming,
            Err(failure) => {
                let (source, cause) = failure.into_parts();
                self.direct = Some(source);
                return Err(cause);
            }
        };
        match incoming.retain_for_qualification() {
            Ok(held) => {
                self.held = Some(held);
                Ok(())
            }
            Err(failure) => {
                let (incoming, cause) = failure.into_parts();
                self.incoming = Some(incoming);
                Err(cause)
            }
        }
    }
    fn pin(&mut self) -> Result<()> {
        match self
            .held
            .as_mut()
            .unwrap()
            .pin_peer(&self.fixture.as_ref().unwrap().runtime)
        {
            Ok(pin) => {
                self.pin = Some(pin);
                Ok(())
            }
            Err(failure) => {
                let cause = failure.cause().code();
                self.failed_pin = Some(failure);
                Err(WorkerReportError::Io(std::io::Error::other(cause)))
            }
        }
    }
    fn split(&mut self) {
        let (connection, _, _, hold) = self.held.take().unwrap().into_parts();
        self.connection = Some(connection);
        self.hold = Some(hold);
    }
    fn finish(&mut self) -> Vec<Box<dyn Error>> {
        self.finished = true;
        let mut errors: Vec<Box<dyn Error>> = Vec::new();
        if let Some(pin) = &mut self.pin
            && let Err(error) = pin.close_metadata()
        {
            errors.push(Box::new(error));
        }
        if let Some(pin) = &mut self.failed_pin
            && let Err(error) = pin.close_metadata()
        {
            errors.push(Box::new(error));
        }
        if self.held.is_some() {
            self.split();
        }
        if let Some(source) = &self.direct
            && let Err(error) = source.close_socket_for_worker()
        {
            errors.push(Box::new(error));
        }
        if let Some(source) = &self.incoming
            && let Err(error) = source.connection().close_socket_for_worker()
        {
            errors.push(Box::new(error));
        }
        if let Some(connection) = &self.connection
            && let Err(error) = connection.close_socket_for_worker()
        {
            errors.push(Box::new(error));
        }
        if let Some(hold) = &mut self.hold
            && let Err(error) = hold.release_for_worker()
        {
            errors.push(Box::new(error));
        }
        if let Some(client) = self.client.take()
            && let Err(error) = nix::unistd::close(client)
        {
            errors.push(Box::new(error));
        }
        if let Err(error) = self.service.close(end()) {
            errors.push(Box::new(error));
        }
        if let Some(fixture) = &self.fixture
            && let Err(error) = fixture.runtime.close(end())
        {
            errors.push(Box::new(error));
        }
        if !errors.is_empty() {
            // Preserve all actual owners on an unconfirmed cleanup; do not
            // delete a working directory or retry consumed native closes.
            std::mem::forget((
                self.fixture.take(),
                self.held.take(),
                self.connection.take(),
                self.hold.take(),
                self.direct.take(),
                self.incoming.take(),
                self.pin.take(),
                self.failed_pin.take(),
                self.service.clone(),
            ));
        }
        errors
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.finish();
        }
    }
}
#[test]
fn actual_l_pin_is_one_shot_and_survives_transport_split() {
    if isolated("actual_l_pin_is_one_shot_and_survives_transport_split") {
        return;
    }
    let mut owned = Owned::new();
    owned.receive().unwrap();
    owned.pin().unwrap();
    let repeated = owned
        .held
        .as_mut()
        .unwrap()
        .pin_peer(&owned.fixture.as_ref().unwrap().runtime);
    let repeat_rejected = repeated.is_err();
    let repeated_closed = match repeated {
        Ok(mut unexpected) => unexpected.close_metadata(),
        Err(mut failure) => failure.close_metadata(),
    };
    owned.split();
    let current = owned.pin.as_ref().unwrap().assert_current(
        &owned.fixture.as_ref().unwrap().runtime,
        owned.connection.as_ref().unwrap(),
    );
    let peer = owned.pin.as_ref().unwrap().peer().pid();
    let close = owned.pin.as_mut().unwrap().close_metadata();
    let finalized = owned.pin.as_ref().unwrap().assert_finalized();
    let records_before_hold_release = owned.service.records.lock().unwrap().len();
    let cleanup = owned.finish();
    assert!(
        repeat_rejected
            && repeated_closed.is_ok()
            && current.is_ok()
            && close.is_ok()
            && finalized.is_ok()
    );
    assert_eq!(peer, i32::try_from(std::process::id()).unwrap());
    assert_eq!(records_before_hold_release, 1);
    assert!(cleanup.is_empty(), "{cleanup:?}");
}
#[test]
fn foreign_runtime_and_record_refuse_before_mutating_the_valid_pin() {
    if isolated("foreign_runtime_and_record_refuse_before_mutating_the_valid_pin") {
        return;
    }
    let mut owned = Owned::new();
    let mut foreign = Owned::new();
    owned.receive().unwrap();
    foreign.receive().unwrap();
    let wrong = owned
        .held
        .as_mut()
        .unwrap()
        .pin_peer(&foreign.fixture.as_ref().unwrap().runtime);
    let wrong_rejected = wrong.is_err();
    let wrong_closed = match wrong {
        Ok(mut unexpected) => unexpected.close_metadata(),
        Err(mut failure) => failure.close_metadata(),
    };
    owned.pin().unwrap();
    owned.split();
    foreign.split();
    let rejected = owned.pin.as_ref().unwrap().assert_current(
        &owned.fixture.as_ref().unwrap().runtime,
        foreign.connection.as_ref().unwrap(),
    );
    let current = owned.pin.as_ref().unwrap().assert_current(
        &owned.fixture.as_ref().unwrap().runtime,
        owned.connection.as_ref().unwrap(),
    );
    let cleanup = owned.finish();
    let foreign_cleanup = foreign.finish();
    assert!(wrong_rejected && wrong_closed.is_ok() && rejected.is_err() && current.is_ok());
    assert!(cleanup.is_empty() && foreign_cleanup.is_empty());
}
#[test]
fn buffered_open_input_is_preserved_but_peer_fin_refuses_while_original_process_is_alive() {
    if isolated(
        "buffered_open_input_is_preserved_but_peer_fin_refuses_while_original_process_is_alive",
    ) {
        return;
    }
    let mut owned = Owned::new();
    owned.receive().unwrap();
    owned.pin().unwrap();
    owned.split();
    owned.client.as_mut().unwrap().write_all(b"x").unwrap();
    let open = owned.pin.as_ref().unwrap().assert_current(
        &owned.fixture.as_ref().unwrap().runtime,
        owned.connection.as_ref().unwrap(),
    );
    let record = owned.service.records.lock().unwrap()[0].clone();
    let mut observed = [0; 1];
    let read = {
        let slot = record.terminal_stream().unwrap();
        nix::sys::socket::recv(
            slot.as_ref().unwrap().as_raw_fd(),
            &mut observed,
            nix::sys::socket::MsgFlags::MSG_DONTWAIT,
        )
    };
    owned.client.as_mut().unwrap().write_all(b"y").unwrap();
    let closed = owned
        .client
        .as_ref()
        .unwrap()
        .shutdown(std::net::Shutdown::Write);
    let refused = owned.pin.as_ref().unwrap().assert_current(
        &owned.fixture.as_ref().unwrap().runtime,
        owned.connection.as_ref().unwrap(),
    );
    let peer = owned.pin.as_ref().unwrap().peer().pid();
    let cleanup = owned.finish();
    assert!(open.is_ok() && matches!(read, Ok(1)) && observed == *b"x");
    assert!(
        closed.is_ok()
            && matches!(
                refused,
                Err(WorkerReportError::Peer | WorkerReportError::Unconfirmed)
            ),
        "known EOF or an unrecognized native hangup flag must refuse currentness"
    );
    assert_eq!(
        peer,
        i32::try_from(std::process::id()).unwrap(),
        "peer process is still executing"
    );
    assert!(cleanup.is_empty(), "{cleanup:?}");
}
#[test]
fn dropped_unfinalized_peer_keeps_original_hold_and_service_unconfirmed() {
    if isolated("dropped_unfinalized_peer_keeps_original_hold_and_service_unconfirmed") {
        return;
    }
    let mut owned = Owned::new();
    owned.receive().unwrap();
    owned.pin().unwrap();
    owned.split();
    let descriptor = owned.pin.as_ref().unwrap().test_descriptor().unwrap();
    drop(owned.pin.take());
    let peer_still_owned = std::fs::read_link(format!("/proc/self/fd/{descriptor}"));
    let opaque = owned.service.records.lock().unwrap()[0].opaque();
    let socket = owned.connection.as_ref().unwrap().close_socket_for_worker();
    let hold = owned.hold.as_mut().unwrap().release_for_worker();
    let service = owned.service.close(end());
    let retained = owned.service.records.lock().unwrap().len();
    let cleanup = owned.finish();
    assert!(
        peer_still_owned.is_ok(),
        "default Drop never closes the peer"
    );
    assert!(opaque && socket.is_err() && hold.is_err() && service.is_err());
    assert_eq!(retained, 1, "the original Record must remain counted");
    assert!(
        !cleanup.is_empty(),
        "whole unknown owner must remain retained"
    );
    // isolate_case owns this actual test process. Its kernel teardown closes
    // the quarantined pidfd; no numeric-descriptor cleanup/retry is attempted.
}
#[test]
fn consumed_peer_close_opacity_retains_the_l_record_and_never_recloses_reused_fd() {
    if isolated("consumed_peer_close_opacity_retains_the_l_record_and_never_recloses_reused_fd") {
        return;
    }
    let mut owned = Owned::new();
    owned.receive().unwrap();
    owned.pin().unwrap();
    owned.split();
    let descriptor = owned.pin.as_ref().unwrap().test_descriptor().unwrap();
    crate::native::test_faults::set(None, true);
    let first = owned.pin.as_mut().unwrap().close_metadata();
    crate::native::test_faults::set(None, false);
    let replacement = std::fs::OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(owned.fixture.as_ref().unwrap().root.join("replacement"))
        .unwrap();
    let reused = replacement.as_raw_fd();
    let second = owned.pin.as_mut().unwrap().close_metadata();
    let replacement_live = replacement.metadata();
    let replacement_closed = crate::native::close(replacement);
    let finalization = owned.pin.as_ref().unwrap().assert_finalized();
    let opaque = owned.service.records.lock().unwrap()[0].opaque();
    let cleanup = owned.finish();
    assert!(matches!(first, Err(WorkerReportError::NativeClose(_))));
    assert_eq!(
        descriptor, reused,
        "actual replacement must occupy the consumed descriptor slot"
    );
    assert!(second.is_err() && finalization.is_err() && opaque);
    assert!(replacement_live.is_ok() && replacement_closed.is_ok());
    assert!(
        !cleanup.is_empty(),
        "opaque original lifecycle must remain retained"
    );
}
