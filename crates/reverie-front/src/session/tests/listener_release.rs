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
