use super::*;
use std::{
    os::unix::{
        fs::{DirBuilderExt, PermissionsExt},
        net::UnixListener,
    },
    sync::{Arc, Barrier},
};

struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let nonce = crate::resource_facts::fresh_owner_nonce().unwrap();
        let path = std::env::temp_dir().join(format!("vw-socket-{}", &nonce.as_str()[..12]));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self(path)
    }
    fn viewer(&self) -> PathBuf {
        self.0.join("viewer.sock")
    }
    fn broker(&self) -> PathBuf {
        self.0.join("broker.sock")
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn full_listener_backlog_refuses_promptly_and_preserves_socket() {
    let tree = Tree::new();
    let owner = Ownership::acquire_at(&tree.viewer(), &tree.broker()).unwrap();
    let listener = UnixListener::bind(tree.viewer()).unwrap();
    fs::set_permissions(tree.viewer(), fs::Permissions::from_mode(0o600)).unwrap();
    socket::listen(&listener, socket::Backlog::new(1).unwrap()).unwrap();
    let address = UnixAddr::new(&tree.viewer()).unwrap();
    let mut clients = Vec::new();
    let mut full = false;
    for _ in 0..16 {
        let fd = socket::socket(
            AddressFamily::Unix,
            SockType::Stream,
            SockFlag::SOCK_CLOEXEC | SockFlag::SOCK_NONBLOCK,
            None,
        )
        .unwrap();
        let result = socket::connect(fd.as_raw_fd(), &address);
        clients.push(fd);
        if result == Err(nix::errno::Errno::EAGAIN) {
            full = true;
            break;
        }
        assert!(result.is_ok(), "actual owned Unix backlog: {result:?}");
    }
    assert!(full);
    let before = fs::symlink_metadata(tree.viewer()).unwrap();
    let started = Instant::now();
    assert_eq!(
        owner.clear_stale().unwrap_err().code,
        "WORKER_VIEWER_ALREADY_LISTENING"
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(
        fs::symlink_metadata(tree.viewer()).unwrap().ino(),
        before.ino()
    );
    for fd in clients {
        close_file(File::from(fd)).unwrap();
    }
    drop(listener);
    owner.finish().unwrap();
}

#[test]
fn simultaneous_start_has_one_lifetime_owner_and_cannot_unlink_winner() {
    let tree = Tree::new();
    let ready = Arc::new(Barrier::new(3));
    let release = Arc::new(Barrier::new(3));
    let (tx, rx) = std::sync::mpsc::channel();
    let mut tasks = Vec::new();
    for _ in 0..2 {
        let path = tree.viewer();
        let broker = tree.broker();
        let ready = ready.clone();
        let release = release.clone();
        let tx = tx.clone();
        tasks.push(std::thread::spawn(move || {
            ready.wait();
            let owner = Ownership::acquire_at(&path, &broker);
            match owner {
                Ok(owner) => {
                    owner.clear_stale().unwrap();
                    let mut listener = broker_listener::BoundSocket::bind(&path).unwrap();
                    tx.send((true, fs::symlink_metadata(&path).unwrap().ino()))
                        .unwrap();
                    release.wait();
                    assert_eq!(
                        fs::symlink_metadata(&path).unwrap().ino(),
                        listener.identity()[1]
                    );
                    listener.remove().unwrap();
                    owner.finish().unwrap();
                }
                Err(cause) => {
                    assert_eq!(cause.code, "WORKER_VIEWER_SOCKET_BUSY");
                    tx.send((false, 0)).unwrap();
                    release.wait();
                }
            }
        }));
    }
    ready.wait();
    let results = [
        rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        rx.recv_timeout(Duration::from_secs(2)).unwrap(),
    ];
    assert_eq!(results.iter().filter(|result| result.0).count(), 1);
    assert_eq!(
        fs::symlink_metadata(tree.viewer()).unwrap().ino(),
        results.iter().find(|result| result.0).unwrap().1
    );
    release.wait();
    for task in tasks {
        task.join().unwrap();
    }
}

#[test]
fn configured_broker_endpoint_and_alias_are_preserved() {
    let tree = Tree::new();
    let listener = UnixListener::bind(tree.broker()).unwrap();
    let original = fs::symlink_metadata(tree.broker()).unwrap().ino();
    let alias = tree.0.join("alias");
    std::os::unix::fs::symlink(&tree.0, &alias).unwrap();
    for path in [tree.broker(), alias.join("broker.sock")] {
        assert_eq!(
            Ownership::acquire_at(&path, &tree.broker())
                .err()
                .unwrap()
                .code,
            "WORKER_VIEWER_BROKER_SOCKET_CONFLICT"
        );
    }
    assert_eq!(fs::symlink_metadata(tree.broker()).unwrap().ino(), original);
    assert!(!tree.0.join("broker.sock.lock").exists());
    drop(listener);
}
