//! Real loopback TLS: the same actor, framing, budgets and transport tasks as production.
use super::*;
use rustls::{
    ClientConfig, RootCertStore,
    pki_types::{CertificateDer, ServerName, UnixTime, pem::PemObject},
};
use std::{path::PathBuf, sync::Arc};
use tokio_rustls::TlsConnector;

fn files() -> TlsFiles {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/tls/fixtures");
    TlsFiles::new(root.join("localhost.crt"), root.join("localhost.key")).unwrap()
}
#[derive(Debug)]
struct Clock;
impl rustls::time_provider::TimeProvider for Clock {
    fn current_time(&self) -> Option<UnixTime> {
        Some(UnixTime::since_unix_epoch(Duration::from_secs(
            1_893_456_000,
        )))
    }
}
fn connector(versions: &[&'static rustls::SupportedProtocolVersion]) -> TlsConnector {
    let mut roots = RootCertStore::empty();
    for cert in CertificateDer::pem_slice_iter(include_bytes!("../../tls/fixtures/localhost.crt")) {
        roots.add(cert.unwrap()).unwrap();
    }
    let mut config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(versions)
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
    config.time_provider = Arc::new(Clock);
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    TlsConnector::from(Arc::new(config))
}
async fn secure_bind(peer: &Peer, listener: Listener) -> u16 {
    peer.send(
        0,
        Body::BindRequest {
            listener,
            host: "127.0.0.1".into(),
            port: 0,
            tls: true,
        },
    )
    .await;
    let frame = peer.non_credit().await;
    let Body::Bound { port, .. } = frame.body else {
        panic!("secure bind: {frame:?}")
    };
    peer.send(0, Body::Accepting { listener }).await;
    port
}

#[test]
fn both_listeners_negotiate_tls12_and_tls13_and_preserve_metadata_binary_and_half_close() {
    runtime().block_on(async {
        let h = Harness::configured(4, DIRECTION_BYTES, Some(files()));
        for (listener, version) in [
            (Listener::Main, &rustls::version::TLS12),
            (Listener::Bridge, &rustls::version::TLS13),
        ] {
            let port = secure_bind(&h.peer, listener).await;
            let raw = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let local_port = raw.local_addr().unwrap().port();
            let mut stream = connector(&[version])
                .connect(ServerName::try_from("localhost").unwrap(), raw)
                .await
                .unwrap();
            assert_eq!(stream.get_ref().1.protocol_version(), Some(version.version));
            assert_eq!(
                stream.get_ref().1.alpn_protocol(),
                Some(b"http/1.1".as_slice())
            );
            let frame = h.peer.non_credit().await;
            let Body::ConnOpen {
                listener: actual,
                peer,
                local,
                encrypted,
            } = frame.body
            else {
                panic!("{frame:?}")
            };
            assert_eq!(actual, listener);
            assert!(encrypted);
            assert_eq!(peer.port, local_port);
            assert_eq!(local.port, port);
            stream.write_all(&[0, 255, 1, 128]).await.unwrap();
            stream.flush().await.unwrap();
            stream.shutdown().await.unwrap();
            h.peer.send(frame.id, Body::Credit(64)).await;
            assert_eq!(
                h.peer.non_credit().await.body,
                Body::Data(vec![0, 255, 1, 128])
            );
            assert_eq!(h.peer.non_credit().await.body, Body::End);
            h.peer
                .send(frame.id, Body::Data(b"TLS response".to_vec()))
                .await;
            h.peer.send(frame.id, Body::End).await;
            let mut received = Vec::new();
            stream.read_to_end(&mut received).await.unwrap();
            assert_eq!(received, b"TLS response");
            let receipt = h.peer.non_credit().await;
            assert_eq!(receipt.id, frame.id);
            assert_eq!(receipt.body, Body::Written(b"TLS response".len() as u64));
        }
        h.finish().await.unwrap();
    });
}
#[test]
fn missing_or_malformed_material_fail_secure_bind_without_plaintext() {
    runtime().block_on(async {
        let missing = TlsFiles::new(
            PathBuf::from("/not-installed/reverie.crt"),
            PathBuf::from("/not-installed/reverie.key"),
        )
        .unwrap();
        let cert = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/tls/fixtures/localhost.crt");
        let bad = TlsFiles::new(cert.clone(), cert).unwrap();
        for selected in [None, Some(missing), Some(bad)] {
            let h = Harness::configured(1, DIRECTION_BYTES, selected);
            h.peer
                .send(
                    0,
                    Body::BindRequest {
                        listener: Listener::Main,
                        host: "127.0.0.1".into(),
                        port: 0,
                        tls: true,
                    },
                )
                .await;
            assert!(matches!(
                h.peer.non_credit().await.body,
                Body::BindFailed { .. }
            ));
            h.finish().await.unwrap();
        }
    });
}
#[test]
fn plaintext_and_wrong_server_name_fail_handshake_without_opening_ts_connection() {
    runtime().block_on(async {
        let h = Harness::configured(3, DIRECTION_BYTES, Some(files()));
        let port = secure_bind(&h.peer, Listener::Main).await;
        let mut plaintext = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        plaintext
            .write_all(b"GET / HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut raw = [0; 128];
        let _ = tokio::time::timeout(Duration::from_secs(2), plaintext.read(&mut raw))
            .await
            .unwrap();
        let socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        assert!(
            connector(&[&rustls::version::TLS13])
                .connect(ServerName::try_from("wrong.example").unwrap(), socket)
                .await
                .is_err()
        );
        // FIFO barrier: no failed handshake may have emitted ConnOpen beforehand.
        h.peer.send(0, Body::ServiceReady).await;
        h.peer
            .send(
                0,
                Body::Unbind {
                    listener: Listener::Main,
                },
            )
            .await;
        h.finish().await.unwrap();
    });
}
#[test]
fn pending_handshake_counts_toward_cap_and_unbind_joins_and_releases_both_pools() {
    runtime().block_on(async {
        let mut state = State::new(NonZeroU64::new(1).unwrap(), 1, DIRECTION_BYTES).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (server, _) = listener.accept().await.unwrap();
        state.listeners[0] = Some(Bound {
            socket: listener,
            accepting: true,
            tls: Some(files().load().await.unwrap()),
            epoch: 1,
        });
        state.tls_scratch = crate::tls::scratch::SharedScratch::reserve(&state.incoming);
        let (events, _receiver) = mpsc::channel(8);
        state
            .accepted(Listener::Main, server, &events)
            .await
            .unwrap();
        assert_eq!(state.handshakes.len(), 1);
        assert!(state.clients.is_empty());
        assert_eq!(
            state.incoming.issued(),
            (crate::tls::HANDSHAKE_RESERVE + crate::tls::scratch::SCRATCH_BYTES) as usize
        );
        assert_eq!(state.outgoing.issued(), crate::tls::TLS_RESERVE as usize);
        let address = state.listeners[0]
            .as_ref()
            .unwrap()
            .socket
            .local_addr()
            .unwrap();
        let mut excess = TcpStream::connect(address).await.unwrap();
        let (server, _) = state.listeners[0]
            .as_ref()
            .unwrap()
            .socket
            .accept()
            .await
            .unwrap();
        state
            .accepted(Listener::Main, server, &events)
            .await
            .unwrap();
        assert_eq!(excess.read(&mut [0; 1]).await.unwrap(), 0);
        assert_eq!(state.handshakes.len(), 1);
        client.write_all(&[22, 3, 3, 0, 32, 1]).await.unwrap();
        state
            .lifecycle(Body::Unbind {
                listener: Listener::Main,
            })
            .unwrap();
        assert!(state.handshakes.next().await.is_none());
        assert_eq!(
            state.incoming.issued(),
            crate::tls::scratch::SCRATCH_BYTES as usize
        );
        assert_eq!(state.outgoing.issued(), 0);
        let result = tokio::time::timeout(Duration::from_secs(2), client.read(&mut [0; 128]))
            .await
            .unwrap();
        assert!(matches!(result, Ok(0) | Err(_)));
        state.close().await;
    });
}
#[test]
fn handshake_timeout_and_generation_deadline_cancel_fragmented_clients_and_return_charges() {
    runtime().block_on(async {
        tokio::time::pause();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (server, _) = listener.accept().await.unwrap();
        let incoming = BytePool::new(DIRECTION_BYTES).unwrap();
        let outgoing = BytePool::new(DIRECTION_BYTES).unwrap();
        let budget = TlsBudget::reserve(&incoming, &outgoing).unwrap();
        let scratch = crate::tls::scratch::SharedScratch::reserve(&incoming).unwrap();
        let config = files().load().await.unwrap();
        let task = tokio::spawn(crate::tls::handshake(server, config, budget, scratch));
        client.write_all(&[22, 3, 3, 0, 32, 1]).await.unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(crate::tls::HANDSHAKE_TIMEOUT + Duration::from_secs(1)).await;
        assert_eq!(
            task.await.unwrap().err().unwrap().kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(incoming.issued(), 0);
        assert_eq!(outgoing.issued(), 0);
        tokio::time::resume();

        let h = Harness::configured(2, DIRECTION_BYTES, Some(files()));
        let port = secure_bind(&h.peer, Listener::Main).await;
        let _pending = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        h.signals
            .send(Some(ShutdownRequest {
                signal: Signal::Term,
                deadline: Instant::now() + Duration::from_millis(30),
            }))
            .unwrap();
        assert!(matches!(
            h.peer.non_credit().await.body,
            Body::Shutdown { .. }
        ));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), h.task)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            SessionEnd::ShutdownDeadline
        );
    });
}
#[test]
fn tls_admission_cannot_exhaust_the_last_payload_window_or_release_unowned_bytes() {
    let input = BytePool::new(crate::tls::HANDSHAKE_RESERVE as usize).unwrap();
    let output = BytePool::new(DIRECTION_BYTES).unwrap();
    assert!(TlsBudget::reserve(&input, &output).is_none());
    assert_eq!(input.issued(), 0);
    assert_eq!(output.issued(), 0);
    let input = BytePool::new(DIRECTION_BYTES).unwrap();
    let mut held = Vec::new();
    while let Some(budget) = TlsBudget::reserve(&input, &output) {
        held.push(budget);
    }
    assert!(!held.is_empty());
    assert!(input.available() >= MAX_DATA_BYTES);
    assert!(output.available() >= MAX_DATA_BYTES);
    drop(held);
    assert_eq!(input.issued(), 0);
    assert_eq!(output.issued(), 0);
}
#[test]
#[ignore = "requires explicit REVERIE_TEST_NODE and REVERIE_TEST_OPENSSL; actual legacy CBC compatibility witness"]
fn pinned_node_accepts_legacy_cbc_while_rust_front_refuses_without_plaintext_fallback() {
    runtime().block_on(async {
        use std::process::Stdio;
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let node = std::env::var_os("REVERIE_TEST_NODE").expect("explicit pinned Node");
        let mut legacy = tokio::process::Command::new(node)
            .arg(root.join("tests/fixtures/tls-cbc-reference.mjs"))
            .arg(root.join("src/tls/fixtures/localhost.crt"))
            .arg(root.join("src/tls/fixtures/localhost.key"))
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let status = tokio::time::timeout(Duration::from_secs(4), legacy.wait()).await;
        if status.is_err() {
            legacy.kill().await.unwrap();
            panic!("legacy witness deadline");
        }
        assert!(status.unwrap().unwrap().success());
        let h = Harness::configured(1, DIRECTION_BYTES, Some(files()));
        let port = secure_bind(&h.peer, Listener::Main).await;
        let openssl = std::env::var_os("REVERIE_TEST_OPENSSL").expect("explicit OpenSSL");
        let mut modern = tokio::process::Command::new(openssl)
            .args([
                "s_client",
                "-connect",
                &format!("127.0.0.1:{port}"),
                "-tls1_2",
                "-cipher",
                "ECDHE-RSA-AES128-SHA256",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let status = tokio::time::timeout(Duration::from_secs(4), modern.wait()).await;
        if status.is_err() {
            modern.kill().await.unwrap();
            panic!("CBC refusal deadline");
        }
        assert!(!status.unwrap().unwrap().success());
        h.finish().await.unwrap();
    });
}
#[test]
fn completed_handshake_from_old_listener_epoch_cannot_open_after_rebind() {
    runtime().block_on(async {
        let mut state = State::new(NonZeroU64::new(1).unwrap(), 2, DIRECTION_BYTES).unwrap();
        state.tls_files = Some(files());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let raw = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (server, _) = listener.accept().await.unwrap();
        state.listeners[0] = Some(Bound {
            socket: listener,
            accepting: true,
            tls: Some(files().load().await.unwrap()),
            epoch: 1,
        });
        state.epoch = 1;
        state.tls_scratch = crate::tls::scratch::SharedScratch::reserve(&state.incoming);
        let (events, _receiver) = mpsc::channel(8);
        state
            .accepted(Listener::Main, server, &events)
            .await
            .unwrap();
        let client = tokio::spawn(async move {
            connector(&[&rustls::version::TLS13])
                .connect(ServerName::try_from("localhost").unwrap(), raw)
                .await
                .unwrap()
        });
        let accepted = state.handshakes.next().await.unwrap();
        let _client = client.await.unwrap();
        state
            .lifecycle(Body::Unbind {
                listener: Listener::Main,
            })
            .unwrap();
        state
            .bind(Listener::Main, "127.0.0.1".into(), 0, true)
            .unwrap();
        let (listener, bound) = state.binds.join_next().await.unwrap().unwrap();
        state.bound(listener, bound).unwrap();
        assert_ne!(state.listeners[0].as_ref().unwrap().epoch, accepted.epoch);
        let (_tx, mut rx) = watch::channel(None);
        let mut control = Control {
            shutdown: None,
            signals_open: true,
        };
        handle_event(
            &mut state,
            &mut rx,
            &events,
            &mut control,
            Event::Handshake(Some(accepted)),
        )
        .await
        .unwrap();
        assert!(state.clients.is_empty());
        assert_eq!(
            state.incoming.issued(),
            crate::tls::scratch::SCRATCH_BYTES as usize
        );
        assert_eq!(state.outgoing.issued(), 0);
        while let Some(frame) = state.outbox.pop() {
            assert!(!matches!(frame.frame().body, Body::ConnOpen { .. }));
        }
        state.close().await;
    });
}
#[test]
#[ignore = "requires explicit REVERIE_TEST_NODE; real verified HTTPS client through Rust TLS and framed peer"]
fn real_node_https_client_verifies_certificate_and_receives_the_framed_response() {
    runtime().block_on(async {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let node = std::env::var_os("REVERIE_TEST_NODE").expect("explicit pinned Node");
        let h = Harness::configured(1, DIRECTION_BYTES, Some(files()));
        let port = secure_bind(&h.peer, Listener::Main).await;
        let mut child = tokio::process::Command::new(node)
            .arg(root.join("tests/fixtures/tls-node-client.mjs"))
            .arg(root.join("src/tls/fixtures/localhost.crt"))
            .arg(port.to_string())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let frame = h.peer.non_credit().await;
        assert!(matches!(
            frame.body,
            Body::ConnOpen {
                encrypted: true,
                ..
            }
        ));
        h.peer.send(frame.id, Body::Credit(4096)).await;
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let body = h.peer.non_credit().await.body;
            let Body::Data(bytes) = body else {
                panic!("HTTP request: {body:?}")
            };
            request.extend_from_slice(&bytes);
            assert!(request.len() <= 4096);
        }
        assert!(request.starts_with(b"GET / HTTP/1.1\r\n"));
        h.peer
            .send(
                frame.id,
                Body::Data(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nnative TLS"
                        .to_vec(),
                ),
            )
            .await;
        h.peer.send(frame.id, Body::End).await;
        let status = tokio::time::timeout(Duration::from_secs(4), child.wait()).await;
        if status.is_err() {
            child.kill().await.unwrap();
            panic!("Node HTTPS client deadline");
        }
        assert!(status.unwrap().unwrap().success());
        h.finish().await.unwrap();
    });
}
#[test]
fn material_descriptor_close_failure_is_bind_failed_after_actual_owned_close() {
    runtime().block_on(async {
        let h = Harness::configured(
            1,
            DIRECTION_BYTES,
            Some(files().with_material_close_failure()),
        );
        h.peer
            .send(
                0,
                Body::BindRequest {
                    listener: Listener::Main,
                    host: "127.0.0.1".into(),
                    port: 0,
                    tls: true,
                },
            )
            .await;
        let frame = h.peer.non_credit().await;
        let Body::BindFailed { message, .. } = frame.body else {
            panic!("false bind success: {frame:?}")
        };
        assert!(message.contains("injected TLS material close failure"));
        h.finish().await.unwrap();
    });
}

struct SecurePair {
    server: Transport,
    client: tokio_rustls::client::TlsStream<TcpStream>,
    incoming: BytePool,
    outgoing: BytePool,
    scratch: Arc<crate::tls::scratch::SharedScratch>,
}
async fn secure_pair() -> SecurePair {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let raw = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (socket, _) = listener.accept().await.unwrap();
    let incoming = BytePool::new(DIRECTION_BYTES).unwrap();
    let outgoing = BytePool::new(DIRECTION_BYTES).unwrap();
    let scratch = crate::tls::scratch::SharedScratch::reserve(&incoming).unwrap();
    let budget = TlsBudget::reserve(&incoming, &outgoing).unwrap();
    let config = files().load().await.unwrap();
    let accepting = tokio::spawn(crate::tls::handshake(
        socket,
        config,
        budget,
        scratch.clone(),
    ));
    let client = connector(&[&rustls::version::TLS13])
        .connect(ServerName::try_from("localhost").unwrap(), raw)
        .await
        .unwrap();
    let server = accepting.await.unwrap().unwrap();
    SecurePair {
        server,
        client,
        incoming,
        outgoing,
        scratch,
    }
}
#[test]
fn independent_tls_halves_progress_with_exhausted_payload_credits_after_shared_parser_release() {
    runtime().block_on(async {
        let SecurePair {
            server,
            mut client,
            incoming,
            outgoing,
            scratch,
        } = secure_pair().await;
        let credits = incoming
            .reserve(NonZeroU32::new(incoming.available() as u32).unwrap())
            .unwrap();
        assert_eq!(incoming.available(), 0);
        let mut waiting = scratch.waiter();
        let held = std::future::poll_fn(|cx| waiting.poll(cx)).await.unwrap();
        let (mut reader, mut writer) = tokio::io::split(server);
        let reading = tokio::spawn(async move {
            let mut bytes = [0; 4];
            reader.read_exact(&mut bytes).await.unwrap();
            bytes
        });
        let writing = tokio::spawn(async move {
            writer.write_all(b"pong").await.unwrap();
            writer.flush().await.unwrap();
        });
        client.write_all(b"ping").await.unwrap();
        client.flush().await.unwrap();
        tokio::task::yield_now().await;
        assert!(!reading.is_finished());
        assert!(!writing.is_finished());
        drop(held);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), reading)
                .await
                .unwrap()
                .unwrap(),
            *b"ping"
        );
        tokio::time::timeout(Duration::from_secs(2), writing)
            .await
            .unwrap()
            .unwrap();
        let mut response = [0; 4];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"pong");
        drop((waiting, scratch, credits));
        assert_eq!(incoming.issued(), 0);
        assert_eq!(outgoing.issued(), 0);
    });
}
#[test]
fn cancelling_tls_read_while_waiting_for_shared_parser_releases_transport_and_queue() {
    runtime().block_on(async {
        let SecurePair {
            mut server,
            client,
            incoming,
            outgoing,
            scratch,
        } = secure_pair().await;
        let mut waiting = scratch.waiter();
        let held = std::future::poll_fn(|cx| waiting.poll(cx)).await.unwrap();
        let reading = tokio::spawn(async move { server.read(&mut [0; 4]).await });
        tokio::task::yield_now().await;
        assert!(!reading.is_finished());
        reading.abort();
        assert!(reading.await.unwrap_err().is_cancelled());
        assert_eq!(
            incoming.issued(),
            crate::tls::scratch::SCRATCH_BYTES as usize
        );
        assert_eq!(outgoing.issued(), 0);
        drop((held, waiting, scratch, client));
        assert_eq!(incoming.issued(), 0);
    });
}
#[test]
fn tls_bind_refuses_when_generation_workspace_cannot_be_precharged() {
    runtime().block_on(async {
        let h = Harness::configured(1, 64, Some(files()));
        h.peer
            .send(
                0,
                Body::BindRequest {
                    listener: Listener::Main,
                    host: "127.0.0.1".into(),
                    port: 0,
                    tls: true,
                },
            )
            .await;
        let frame = h.peer.non_credit().await;
        let Body::BindFailed { errno, message, .. } = frame.body else {
            panic!("uncharged TLS bind: {frame:?}")
        };
        assert_eq!(errno, "ENOMEM");
        assert!(message.contains("parser workspace"));
        h.finish().await.unwrap();
    });
}
