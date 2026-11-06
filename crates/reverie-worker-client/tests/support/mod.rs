use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub(crate) const SID: &str = "11111111-2222-3333-4444-555555555555";
pub(crate) const BIN: &str = env!("CARGO_BIN_EXE_reverie-worker-exec");
static NEXT: AtomicU64 = AtomicU64::new(0);
pub(crate) struct Tree {
    pub(crate) root: PathBuf,
    pub(crate) socket: PathBuf,
    listener: UnixListener,
}
impl Tree {
    pub(crate) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "rvwc-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = root.join("broker.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        listener.set_nonblocking(true).unwrap();
        Self {
            root,
            socket,
            listener,
        }
    }
    pub(crate) fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(BIN);
        command
            .args(args)
            .env_clear()
            .env("REVERIE_WORKER_SOCKET", &self.socket)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
    pub(crate) fn accept(&self) -> UnixStream {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    return stream;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "no client connection");
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("{error}"),
            }
        }
    }
    pub(crate) fn no_connection(&self) {
        assert!(
            matches!(self.listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
        );
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
pub(crate) fn receive(stream: &mut UnixStream) -> (u8, Vec<u8>) {
    let mut header = [0_u8; 5];
    stream.read_exact(&mut header).unwrap();
    let size = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    assert!(size <= 262_144);
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).unwrap();
    (header[0], bytes)
}
pub(crate) fn send(stream: &mut UnixStream, kind: u8, raw: &[u8]) {
    stream.write_all(&[kind]).unwrap();
    stream.write_all(&(raw.len() as u32).to_be_bytes()).unwrap();
    stream.write_all(raw).unwrap();
}
pub(crate) fn custody() -> Value {
    let names = [
        "config",
        "configRoot",
        "key",
        "keyRoot",
        "canonical",
        "canonicalRoot",
        "nonce",
        "nonceRoot",
        "authority",
        "authorityRoot",
        "canonicalLock",
        "nonceLock",
        "noncePending",
        "nonceParent",
    ];
    let identities: serde_json::Map<_, _> = names
        .into_iter()
        .map(|name| (name.into(), Value::Null))
        .collect();
    serde_json::json!({"version":1,"configDigest":"a".repeat(64),"identities":identities})
}
pub(crate) struct Process {
    pub(crate) child: Child,
    stdout: Option<JoinHandle<Vec<u8>>>,
    stderr: Option<JoinHandle<Vec<u8>>>,
}
fn drain(mut reader: impl Read + Send + 'static) -> JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        bytes
    })
}
impl Process {
    pub(crate) fn spawn(command: &mut Command) -> Self {
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().map(drain);
        let stderr = child.stderr.take().map(drain);
        Self {
            child,
            stdout,
            stderr,
        }
    }
    pub(crate) fn wait(mut self) -> Output {
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "client did not terminate");
            std::thread::sleep(Duration::from_millis(2));
        };
        Output {
            status,
            stdout: self
                .stdout
                .take()
                .map_or(Vec::new(), |thread| thread.join().unwrap()),
            stderr: self
                .stderr
                .take()
                .map_or(Vec::new(), |thread| thread.join().unwrap()),
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _killed = self.child.kill();
        let _waited = self.child.wait();
    }
}
