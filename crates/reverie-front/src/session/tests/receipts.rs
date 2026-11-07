use super::*;
use std::io::{Read, Write};

async fn draining_response() -> (State, TcpStream) {
    let mut state = State::new(NonZeroU64::new(1).unwrap(), 1, 64).unwrap();
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
    let (events, mut network) = mpsc::channel(8);
    state
        .accepted(Listener::Main, socket, &events)
        .await
        .unwrap();
    state.grant_waiters().unwrap();
    while state.outbox.pop().is_some() {}
    peer.shutdown().await.unwrap();
    state
        .receive(Frame {
            generation: 1,
            id: 1,
            body: Body::Credit(64),
        })
        .await
        .unwrap();
    state.start_readers().unwrap();
    state.network(network.recv().await.unwrap()).await.unwrap();
    assert_eq!(state.outbox.pop().unwrap().frame().body, Body::End);
    for body in [Body::Data(vec![7; 32]), Body::End] {
        state
            .receive(Frame {
                generation: 1,
                id: 1,
                body,
            })
            .await
            .unwrap();
    }
    assert_eq!(
        state.table.open_count(),
        1,
        "both ends precede the native write"
    );
    while !state.clients[&1].write_ended {
        state.clients.get_mut(&1).unwrap().pump_write().unwrap();
        state.network(network.recv().await.unwrap()).await.unwrap();
    }
    assert_eq!(state.clients[&1].written, 32);
    assert_eq!(state.clients[&1].acknowledged, 0);
    (state, peer)
}

fn congested_channel() -> (Channel, UnixStream, usize) {
    let (mut socket, peer) = UnixStream::pair().unwrap();
    socket.set_nonblocking(true).unwrap();
    let mut queued = 0;
    for chunk in [&[0; 4096][..], &[0][..]] {
        loop {
            match socket.write(chunk) {
                Ok(bytes) => queued += bytes,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                other => panic!("fill actual channel: {other:?}"),
            }
        }
    }
    socket.set_nonblocking(false).unwrap();
    (Channel::start(socket).unwrap(), peer, queued)
}

async fn drain_channel(mut peer: UnixStream, queued: usize) -> Frame {
    tokio::task::spawn_blocking(move || {
        peer.read_exact(&mut vec![0; queued]).unwrap();
        read_frame(&mut peer, Direction::ToTs).unwrap().unwrap()
    })
    .await
    .unwrap()
}

#[test]
fn late_abort_cancels_transport_after_the_table_has_closed() {
    runtime().block_on(async {
        let (mut state, _client) = draining_response().await;
        let (mut channel, peer, queued) = congested_channel();
        state.pump(&channel).unwrap();
        assert_eq!(drain_channel(peer, queued).await.body, Body::Written(32));
        state
            .channel_finished(channel.finished.recv().await.unwrap())
            .unwrap();
        assert_eq!(state.table.open_count(), 0);
        assert_eq!(
            state.clients.len(),
            1,
            "transport still retained until retirement"
        );
        state
            .receive(Frame {
                generation: 1,
                id: 1,
                body: Body::Abort(AbortReason::Destroy),
            })
            .await
            .unwrap();
        assert!(state.clients.is_empty());
        state.close().await;
        channel.finish().await.unwrap();
    });
}

#[test]
fn already_observed_generation_loss_discards_the_pending_terminal_receipt() {
    runtime().block_on(async {
        let (state, _client) = draining_response().await;
        let (socket, mut peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let channel = Channel::start(socket).unwrap();
        let (_signals, rx) = watch::channel(None);
        let (_loss, lost) = watch::channel(true);
        let task = tokio::spawn(run_owned(channel, state, rx, Some(lost)));
        let peer = tokio::task::spawn_blocking(move || {
            assert_eq!(read_frame(&mut peer, Direction::ToTs).unwrap(), None);
            peer
        })
        .await
        .unwrap();
        peer.shutdown(Shutdown::Both).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), SessionEnd::GenerationLost);
    });
}

#[test]
fn final_receipt_survives_channel_backpressure_and_only_completion_retires_the_id() {
    runtime().block_on(async {
        let (mut state, mut client) = draining_response().await;
        state.retire_drained().await;
        assert_eq!(
            state.clients.len(),
            1,
            "queued final receipt retains the client"
        );
        let (mut channel, peer, queued) = congested_channel();
        state.pump(&channel).unwrap();
        assert!(matches!(
            channel.finished.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        state.retire_drained().await;
        assert_eq!(
            state.table.open_count(),
            1,
            "commit to writer is not write completion"
        );
        assert_eq!(state.clients.len(), 1);
        let frame = drain_channel(peer, queued).await;
        assert_eq!(frame.body, Body::Written(32));
        state
            .channel_finished(channel.finished.recv().await.unwrap())
            .unwrap();
        assert_eq!(state.table.open_count(), 0);
        state.retire_drained().await;
        assert!(state.clients.is_empty());
        let mut bytes = Vec::new();
        client.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, vec![7; 32]);
        state.close().await;
        channel.finish().await.unwrap();
    });
}

#[test]
fn abort_discards_a_pending_receipt_and_settles_an_already_committed_receipt() {
    runtime().block_on(async {
        for committed in [false, true] {
            let (mut state, _client) = draining_response().await;
            let (mut channel, peer, queued) = congested_channel();
            if committed {
                state.pump(&channel).unwrap();
            }
            state
                .receive(Frame {
                    generation: 1,
                    id: 1,
                    body: Body::Abort(AbortReason::Destroy),
                })
                .await
                .unwrap();
            assert!(state.clients.is_empty());
            assert_eq!(state.table.open_count(), 0);
            assert!(
                state.outbox.pop().is_none(),
                "no pending receipt survives abort"
            );
            if committed {
                assert_eq!(drain_channel(peer, queued).await.body, Body::Written(32));
                state
                    .channel_finished(channel.finished.recv().await.unwrap())
                    .unwrap();
                assert!(
                    state.clients.is_empty(),
                    "late writer completion cannot resurrect the id"
                );
            } else {
                drop(peer);
            }
            state.close().await;
            channel.finish().await.unwrap();
        }
    });
}
