use super::*;
use reverie_contracts::route_frames_v2::{Direction, read_frame};
use std::{io::Write, net::Shutdown, os::unix::net::UnixStream};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(target_os = "linux")]
mod listener_release;
mod receipts;
#[cfg(target_os = "linux")]
mod stderr;
mod tls;

struct Peer(UnixStream);
impl Peer {
    async fn send(&self, id: u64, body: Body) {
        let mut socket = self.0.try_clone().unwrap();
        let bytes = Frame {
            generation: 1,
            id,
            body,
        }
        .encode(Direction::ToFront)
        .unwrap();
        tokio::task::spawn_blocking(move || socket.write_all(&bytes))
            .await
            .unwrap()
            .unwrap();
    }
    async fn receive(&self) -> Frame {
        let mut socket = self.0.try_clone().unwrap();
        tokio::task::spawn_blocking(move || read_frame(&mut socket, Direction::ToTs))
            .await
            .unwrap()
            .unwrap()
            .expect("frame, not EOF")
    }
    async fn non_credit(&self) -> Frame {
        loop {
            let frame = self.receive().await;
            if !matches!(frame.body, Body::Credit(_)) {
                return frame;
            }
        }
    }
    async fn bind(&self, listener: Listener) -> u16 {
        self.send(
            0,
            Body::BindRequest {
                listener,
                host: "127.0.0.1".into(),
                port: 0,
                tls: false,
            },
        )
        .await;
        let frame = self.non_credit().await;
        let Body::Bound {
            listener: actual,
            port,
        } = frame.body
        else {
            panic!("bound: {frame:?}")
        };
        assert_eq!(actual, listener);
        assert_ne!(port, 0);
        self.send(0, Body::Accepting { listener }).await;
        port
    }
    async fn open(&self, port: u16, listener: Listener) -> (u64, TcpStream) {
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let frame = self.non_credit().await;
        let Body::ConnOpen {
            listener: actual,
            peer,
            local,
            encrypted,
        } = frame.body
        else {
            panic!("open: {frame:?}")
        };
        assert_eq!(actual, listener);
        assert_eq!(local.port, port);
        assert_eq!(peer.port, stream.local_addr().unwrap().port());
        assert!(!encrypted);
        (frame.id, stream)
    }
}
struct Harness {
    peer: Peer,
    signals: watch::Sender<Option<ShutdownRequest>>,
    task: tokio::task::JoinHandle<io::Result<SessionEnd>>,
}
impl Harness {
    fn start(maximum: usize, bytes: usize) -> Self {
        Self::configured(maximum, bytes, None)
    }
    fn configured(maximum: usize, bytes: usize, files: Option<TlsFiles>) -> Self {
        let (socket, peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        peer.set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let channel = Channel::start(socket).unwrap();
        let mut state = State::new(NonZeroU64::new(1).unwrap(), maximum, bytes).unwrap();
        state.tls_files = files;
        let (signals, rx) = watch::channel(None);
        let task = tokio::spawn(run_bounded(channel, state, rx));
        Self {
            peer: Peer(peer),
            signals,
            task,
        }
    }
    async fn finish(self) -> io::Result<SessionEnd> {
        self.peer.0.shutdown(Shutdown::Both).unwrap();
        tokio::time::timeout(Duration::from_secs(5), self.task)
            .await
            .unwrap()
            .unwrap()
    }
}
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn tcp_port_zero_peer_facts_and_half_close_preserve_both_byte_streams() {
    runtime().block_on(qualify_half_close());
}
async fn qualify_half_close() {
    let h = Harness::start(2, 128);
    let port = h.peer.bind(Listener::Main).await;
    h.peer.send(0, Body::ServiceReady).await;
    let (id, mut client) = h.peer.open(port, Listener::Main).await;
    assert_eq!(h.peer.receive().await.body, Body::Credit(128));
    // The client may already have bytes queued; the front needs explicit TS credit.
    client.write_all(b"request").await.unwrap();
    client.shutdown().await.unwrap();
    h.peer.send(id, Body::Credit(128)).await;
    assert_eq!(
        h.peer.non_credit().await.body,
        Body::Data(b"request".to_vec())
    );
    assert_eq!(h.peer.non_credit().await.body, Body::End);
    // Half-close of the request direction still permits response data.
    h.peer.send(id, Body::Data(b"response".to_vec())).await;
    h.peer.send(id, Body::End).await;
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.unwrap();
    assert_eq!(response, b"response");
    assert_eq!(h.finish().await.unwrap(), SessionEnd::ChannelClosed);
}

#[test]
fn bridge_is_tagged_unbind_preserves_client_and_extra_connections_are_closed() {
    runtime().block_on(qualify_bridge_and_cap());
}
async fn qualify_bridge_and_cap() {
    let h = Harness::start(1, 128);
    let main = h.peer.bind(Listener::Main).await;
    let bridge = h.peer.bind(Listener::Bridge).await;
    let (id, mut client) = h.peer.open(bridge, Listener::Bridge).await;
    assert_eq!(h.peer.receive().await.body, Body::Credit(128));
    let mut extra = TcpStream::connect(("127.0.0.1", main)).await.unwrap();
    assert_eq!(extra.read(&mut [0]).await.unwrap(), 0);
    h.peer
        .send(
            0,
            Body::Unbind {
                listener: Listener::Bridge,
            },
        )
        .await;
    // FIFO input followed by actual network consumption forms the barrier.
    client.write_all(b"barrier").await.unwrap();
    h.peer.send(id, Body::Credit(64)).await;
    assert_eq!(
        h.peer.non_credit().await.body,
        Body::Data(b"barrier".to_vec())
    );
    // Exact listener release is checked independently in listener_release.
    // Another concurrent fixture may already own this ephemeral endpoint.
    h.peer.send(id, Body::Abort(AbortReason::Destroy)).await;
    h.finish().await.unwrap();
}

#[test]
fn exhausted_receive_pool_does_not_block_shutdown_or_other_client_requests() {
    runtime().block_on(qualify_exhausted_pool());
}
async fn qualify_exhausted_pool() {
    let h = Harness::start(3, 64);
    let port = h.peer.bind(Listener::Main).await;
    let (first, _slow) = h.peer.open(port, Listener::Main).await;
    assert_eq!(h.peer.receive().await.body, Body::Credit(64));
    let (second, mut active) = h.peer.open(port, Listener::Main).await;
    active.write_all(b"other-client").await.unwrap();
    h.peer.send(second, Body::Credit(64)).await;
    assert_eq!(
        h.peer.non_credit().await.body,
        Body::Data(b"other-client".to_vec())
    );
    h.signals
        .send(Some(ShutdownRequest::new(Signal::Term)))
        .unwrap();
    assert!(matches!(
        h.peer.non_credit().await.body,
        Body::Shutdown {
            signal: Signal::Term
        }
    ));
    // Closing the holder returns its unused issued grant to the waiting client.
    h.peer.send(first, Body::Abort(AbortReason::Destroy)).await;
    let grant = h.peer.receive().await;
    assert_eq!(grant.id, second);
    assert_eq!(grant.body, Body::Credit(64));
    h.finish().await.unwrap();
}

#[test]
fn crossed_abort_and_late_frames_settle_but_a_never_opened_id_faults() {
    runtime().block_on(qualify_late_frames());
}
async fn qualify_late_frames() {
    let h = Harness::start(2, 64);
    let port = h.peer.bind(Listener::Main).await;
    let (id, mut client) = h.peer.open(port, Listener::Main).await;
    assert!(matches!(h.peer.receive().await.body, Body::Credit(_)));
    h.peer.send(id, Body::Abort(AbortReason::Destroy)).await;
    assert_eq!(client.read(&mut [0]).await.unwrap(), 0);
    for body in [
        Body::Abort(AbortReason::PeerReset),
        Body::Data(vec![1]),
        Body::End,
        Body::Credit(99),
    ] {
        h.peer.send(id, body).await;
    }
    let (_next, _client) = h.peer.open(port, Listener::Main).await;
    h.peer.send(999, Body::End).await;
    let error = tokio::time::timeout(Duration::from_secs(5), h.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.to_string(), "CONN_UNOPENED");
}

#[test]
fn credit_overrun_aborts_the_generation_and_every_client() {
    runtime().block_on(qualify_overrun());
}
async fn qualify_overrun() {
    let h = Harness::start(2, 4);
    let port = h.peer.bind(Listener::Main).await;
    let (id, mut client) = h.peer.open(port, Listener::Main).await;
    assert_eq!(h.peer.receive().await.body, Body::Credit(4));
    h.peer.send(id, Body::Data(vec![1; 5])).await;
    assert_eq!(client.read(&mut [0]).await.unwrap(), 0);
    let error = tokio::time::timeout(Duration::from_secs(5), h.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.to_string(), "credit overrun");
}

#[test]
fn accepting_before_bound_is_a_generation_fault() {
    runtime().block_on(qualify_bad_lifecycle());
}
async fn qualify_bad_lifecycle() {
    let h = Harness::start(1, 64);
    h.peer
        .send(
            0,
            Body::Accepting {
                listener: Listener::Main,
            },
        )
        .await;
    let error = tokio::time::timeout(Duration::from_secs(5), h.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.to_string(), "accepting before bound");
}

#[test]
fn freed_receive_credit_goes_to_existing_waiters_before_the_streaming_consumer() {
    runtime().block_on(qualify_grant_fairness());
}
async fn qualify_grant_fairness() {
    let h = Harness::start(3, 2 * MAX_DATA_BYTES);
    let port = h.peer.bind(Listener::Main).await;
    let (first, mut a) = h.peer.open(port, Listener::Main).await;
    assert_eq!(
        h.peer.receive().await.body,
        Body::Credit(MAX_DATA_BYTES as u32)
    );
    let (_second, _b) = h.peer.open(port, Listener::Main).await;
    assert_eq!(
        h.peer.receive().await.body,
        Body::Credit(MAX_DATA_BYTES as u32)
    );
    let (waiting, _c) = h.peer.open(port, Listener::Main).await;
    h.peer
        .send(first, Body::Data(vec![9; MAX_DATA_BYTES]))
        .await;
    let mut received = vec![0; MAX_DATA_BYTES];
    a.read_exact(&mut received).await.unwrap();
    assert_eq!(received, vec![9; MAX_DATA_BYTES]);
    // Releasing the packet lease can wake grant distribution before the
    // separate native-write event. Both independent controls must arrive.
    let controls = [h.peer.receive().await, h.peer.receive().await];
    assert!(
        controls.iter().any(|frame| frame.generation == 1
            && frame.id == first
            && frame.body == Body::Written(MAX_DATA_BYTES as u64)),
        "missing exact write receipt: {controls:?}"
    );
    assert!(
        controls.iter().any(|frame| frame.generation == 1
            && frame.id == waiting
            && frame.body == Body::Credit(MAX_DATA_BYTES as u32)),
        "freed credit must reach the existing waiter: {controls:?}"
    );
    h.finish().await.unwrap();
}

#[test]
fn local_abort_after_both_queued_ends_still_reaches_ts_and_crossing_data_is_late() {
    runtime().block_on(qualify_queued_end_abort());
}
async fn qualify_queued_end_abort() {
    let mut state = State::new(NonZeroU64::new(1).unwrap(), 2, 64).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut peer = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (socket, _) = listener.accept().await.unwrap();
    state.listeners[0] = Some(Bound {
        socket: listener,
        accepting: true,
        tls: None,
        epoch: 1,
    });
    let (events, _network) = mpsc::channel(4);
    state
        .accepted(Listener::Main, socket, &events)
        .await
        .unwrap();
    state.grant_waiters().unwrap();
    assert_eq!(state.incoming.issued(), 64);
    while state.outbox.pop().is_some() {}
    assert!(state.table.send(1, ConnFrame::End).unwrap());
    state.outbox.stream(1, StreamPacket::End).unwrap();
    assert_eq!(
        state.table.receive(1, ConnFrame::End).unwrap(),
        Received::Ended { closed: true }
    );
    state.abort(1).await.unwrap();
    assert!(matches!(
        state.outbox.pop().unwrap().frame().body,
        Body::Abort(_)
    ));
    assert!(
        state.outbox.pop().is_none(),
        "the queued end was intentionally discarded"
    );
    assert_eq!(state.incoming.issued(), 0);
    assert_eq!(peer.read(&mut [0]).await.unwrap(), 0);
    // Reuse the released capacity before the authorized old DATA crosses back.
    let mut reused = state
        .incoming
        .reserve(NonZeroU32::new(64).unwrap())
        .unwrap();
    let raw = Frame {
        generation: 1,
        id: 1,
        body: Body::Data(vec![8; 64]),
    };
    state.receive(raw).await.unwrap();
    assert_eq!(
        state.incoming.issued(),
        64,
        "late DATA must not release the new charge"
    );
    let charged = reused.split(NonZeroU32::new(64).unwrap()).unwrap();
    drop(charged);
    drop(reused);
    assert_eq!(state.incoming.issued(), 0);
    state.close().await;
}

#[test]
fn pending_bind_jobs_do_not_block_shutdown_deadline_or_channel_eof() {
    runtime().block_on(qualify_pending_bind());
}
async fn qualify_pending_bind() {
    for shutdown in [true, false] {
        let (socket, peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let channel = Channel::start(socket).unwrap();
        let mut state = State::new(NonZeroU64::new(1).unwrap(), 1, 64).unwrap();
        // The same owned job slot as hostname resolution, controlled without DNS.
        state.binding[0] = true;
        state.binds.spawn(pending::<BindResult>());
        let (tx, rx) = watch::channel(None);
        let task = tokio::spawn(run_bounded(channel, state, rx));
        let peer = Peer(peer);
        if shutdown {
            tx.send(Some(ShutdownRequest {
                signal: Signal::Term,
                deadline: Instant::now() + Duration::from_millis(30),
            }))
            .unwrap();
            assert!(matches!(
                peer.non_credit().await.body,
                Body::Shutdown { .. }
            ));
        } else {
            peer.0.shutdown(Shutdown::Both).unwrap();
        }
        let result = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            result,
            if shutdown {
                SessionEnd::ShutdownDeadline
            } else {
                SessionEnd::ChannelClosed
            }
        );
    }
}

#[test]
fn observed_child_loss_closes_clients_before_waiting_for_held_channel_eof() {
    runtime().block_on(qualify_generation_loss());
}
async fn qualify_generation_loss() {
    let (socket, peer) = UnixStream::pair().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let peer = Peer(peer);
    let channel = Channel::start(socket).unwrap();
    let state = State::new(NonZeroU64::new(1).unwrap(), 2, 64).unwrap();
    let (_signals, rx) = watch::channel(None);
    let (loss, lost) = watch::channel(false);
    let task = tokio::spawn(run_owned(channel, state, rx, Some(lost)));
    let port = peer.bind(Listener::Main).await;
    let (_id, mut client) = peer.open(port, Listener::Main).await;
    assert!(matches!(peer.receive().await.body, Body::Credit(_)));
    loss.send(true).unwrap();
    // The held endpoint prevents EOF: network teardown must precede codec drain.
    let read = tokio::time::timeout(Duration::from_secs(1), client.read(&mut [0]))
        .await
        .unwrap();
    assert_eq!(read.unwrap(), 0);
    assert!(
        !task.is_finished(),
        "codec-only drain still awaits held endpoint"
    );
    // Even a queued bind request after loss cannot create a replacement listener.
    peer.send(
        0,
        Body::BindRequest {
            listener: Listener::Main,
            host: "127.0.0.1".into(),
            port,
            tls: false,
        },
    )
    .await;
    peer.0.shutdown(Shutdown::Both).unwrap();
    assert_eq!(task.await.unwrap().unwrap(), SessionEnd::GenerationLost);
}
