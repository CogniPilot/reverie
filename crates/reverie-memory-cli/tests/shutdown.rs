//! Actual standalone negative termination, not an API release/save receipt.
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("memory-consumed-close-{}", std::process::id()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        fs::create_dir(root.join("config")).unwrap();
        fs::write(root.join("config/instance.json"),r#"{"id":"synthetic","agent_name":"Agent","owner_name":"Owner","data_dir":"../state","persona":"Chosen persona"}"#).unwrap();
        Self(root)
    }
    fn command(&self, url: &str) -> Command {
        let program = std::env::var_os("NIX_REVERIE_TEST_MEMORY_CLI")
            .unwrap_or_else(|| env!("CARGO_BIN_EXE_reverie-memory").into());
        let mut command = Command::new(program);
        command
            .env_clear()
            .env("HOME", &self.0)
            .env("PATH", "")
            .env(
                "REVERIE_INSTANCE_CONFIG",
                self.0.join("config/instance.json"),
            )
            .env("REVERIE_EMBED_URL", url);
        command
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
struct OwnedChild(Option<Child>);
impl OwnedChild {
    fn spawn(mut command: Command) -> Self {
        Self(Some(
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        ))
    }
    fn child(&mut self) -> &mut Child {
        self.0.as_mut().unwrap()
    }
    fn output(mut self) -> std::process::Output {
        self.0.take().unwrap().wait_with_output().unwrap()
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
#[test]
fn observed_control_rebinding_terminates_negative_after_consumed_finalizers() {
    let tree = Tree::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (entered, paused) = mpsc::channel();
    let (released, resume) = mpsc::channel();
    let server = std::thread::spawn(move || serve(listener, entered, resume));
    let mut startup = tree.command(&url);
    startup.arg("--initialize");
    let startup = startup.output().unwrap();
    assert!(
        startup.status.success(),
        "{}",
        String::from_utf8_lossy(&startup.stderr)
    );
    let database = tree.0.join("state/memory.sqlite");
    let before = fs::read(&database).unwrap();
    let profile = fs::read(tree.0.join("state/profile.md")).unwrap();
    let mut recall = OwnedChild::spawn(tree.command(&url));
    recall
        .child()
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"action":"recall","private":true,"query":"synthetic"}"#)
        .unwrap();
    paused.recv_timeout(Duration::from_secs(5)).unwrap();
    let lock = tree.0.join("state/.memory-lifecycle-v1.lock");
    let prior = fs::metadata(&lock).unwrap();
    fs::rename(&lock, lock.with_extension("retired")).unwrap();
    fs::write(&lock, b"").unwrap();
    fs::set_permissions(&lock, fs::Permissions::from_mode(0o600)).unwrap();
    let replacement = fs::metadata(&lock).unwrap();
    assert_ne!(prior.ino(), replacement.ino());
    released.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while recall.child().try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        recall.child().try_wait().unwrap().is_some(),
        "consumed permanent refusal must not poll forever"
    );
    let result = recall.output();
    assert_eq!(result.status.code(), Some(1));
    assert!(result.stdout.is_empty());
    let error: serde_json::Value = serde_json::from_slice(&result.stderr).unwrap();
    assert!(error["error"].as_str().unwrap().contains("control"));
    assert_eq!(fs::metadata(&lock).unwrap().ino(), replacement.ino());
    assert_eq!(fs::read(&lock).unwrap(), b"");
    assert_eq!(fs::read(database).unwrap(), before);
    assert_eq!(fs::read(tree.0.join("state/profile.md")).unwrap(), profile);
    server.join().unwrap();
}
fn serve(listener: TcpListener, entered: mpsc::Sender<()>, resume: mpsc::Receiver<()>) {
    for index in 0..2 {
        let mut socket = accept(&listener);
        consume(&mut socket);
        if index == 1 {
            entered.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        let body = br#"{"data":[{"embedding":[3,4]}]}"#;
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .unwrap();
        socket.write_all(body).unwrap();
    }
    assert!(matches!(listener.accept(),Err(error)if error.kind()==std::io::ErrorKind::WouldBlock));
}
fn accept(listener: &TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match listener.accept() {
            Ok((socket, _)) => {
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                return socket;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("{error}"),
        }
    }
}
fn consume(socket: &mut TcpStream) {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        socket.read_exact(&mut byte).unwrap();
        header.push(byte[0]);
        assert!(header.len() < 65536);
    }
    let header = String::from_utf8(header).unwrap();
    let size = header
        .split("\r\n")
        .find_map(|line| {
            line.split_once(':')
                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    let mut body = vec![0; size];
    socket.read_exact(&mut body).unwrap();
}
