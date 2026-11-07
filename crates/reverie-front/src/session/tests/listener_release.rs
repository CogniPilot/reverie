//! Assert this process's exact listener ownership, not a globally free port.
use super::*;
use std::{
    fs,
    os::fd::AsRawFd,
    path::{Path, PathBuf},
};

fn referenced(identity: &Path) -> bool {
    fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
        .any(|entry| entry == identity)
}
fn identity(listener: &std::net::TcpListener) -> PathBuf {
    fs::read_link(format!("/proc/self/fd/{}", listener.as_raw_fd())).unwrap()
}
fn install(listener: std::net::TcpListener) -> State {
    listener.set_nonblocking(true).unwrap();
    let mut state = State::new(NonZeroU64::new(1).unwrap(), 1, 64).unwrap();
    state.listeners[index(Listener::Bridge)] = Some(Bound {
        socket: TcpListener::from_std(listener).unwrap(),
        accepting: true,
        tls: None,
        epoch: 0,
    });
    state
}

#[test]
fn unbind_releases_exact_owned_listener_even_if_descriptor_number_is_reused() {
    runtime().block_on(async {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let original = identity(&listener);
        let mut state = install(listener);
        assert!(referenced(&original));
        state
            .lifecycle(Body::Unbind {
                listener: Listener::Bridge,
            })
            .unwrap();
        assert!(state.listeners[index(Listener::Bridge)].is_none());
        assert!(!referenced(&original));
        // A different listener may reuse the old descriptor number. Its socket
        // identity must not be mistaken for retained ownership of the old one.
        let other = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        assert_ne!(identity(&other), original);
        assert!(!referenced(&original));
    });
}

#[test]
fn ownership_guard_detects_a_retained_duplicate_after_original_fd_is_closed() {
    runtime().block_on(async {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let original = identity(&listener);
        let retained = listener.try_clone().unwrap();
        let mut state = install(listener);
        state
            .lifecycle(Body::Unbind {
                listener: Listener::Bridge,
            })
            .unwrap();
        assert!(state.listeners[index(Listener::Bridge)].is_none());
        assert!(referenced(&original));
        drop(retained);
        assert!(!referenced(&original));
    });
}

#[test]
fn generation_loss_releases_owned_listener_even_when_a_new_endpoint_reuses_its_port() {
    runtime().block_on(async {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let original = fs::read_link(format!("/proc/self/fd/{}", listener.as_raw_fd())).unwrap();
        let (socket, peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let peer = Peer(peer);
        let channel = Channel::start(socket).unwrap();
        let mut state = State::new(NonZeroU64::new(1).unwrap(), 2, 64).unwrap();
        state.listeners[0] = Some(Bound {
            socket: listener,
            accepting: true,
            tls: None,
            epoch: 1,
        });
        let (_signals, rx) = watch::channel(None);
        let (loss, lost) = watch::channel(false);
        let task = tokio::spawn(run_owned(channel, state, rx, Some(lost)));
        let (_id, mut client) = peer.open(port, Listener::Main).await;
        assert!(matches!(peer.receive().await.body, Body::Credit(_)));
        assert!(referenced(&original));
        loss.send(true).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), client.read(&mut [0]))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(
            !referenced(&original),
            "original owned listener must be released before codec drain"
        );
        assert!(!task.is_finished(), "held channel still prevents codec EOF");
        let replacement = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        let replacement_identity =
            fs::read_link(format!("/proc/self/fd/{}", replacement.as_raw_fd())).unwrap();
        assert_ne!(replacement_identity, original);
        assert!(
            TcpStream::connect(("127.0.0.1", port)).await.is_ok(),
            "global port-connect failure is not an owned-listener oracle"
        );
        assert!(!referenced(&original));
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
        assert!(!referenced(&original));
        drop(replacement);
    });
}
