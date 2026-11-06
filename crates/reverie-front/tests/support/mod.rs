use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use serde_json::Value;
use std::{io, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    process::{Child, Command},
    sync::mpsc,
    task::JoinHandle,
};
#[derive(Clone, Copy, Debug)]
pub(crate) enum Mode {
    Front,
    Direct,
}
pub(crate) struct Running {
    child: Child,
    events: mpsc::Receiver<Value>,
    logs: JoinHandle<()>,
    pub(crate) history: Vec<Value>,
    pub(crate) port: u16,
}
impl Running {
    pub(crate) async fn start(mode: Mode) -> Self {
        let node = std::env::var_os("REVERIE_TEST_NODE").expect("explicit pinned Node");
        let setting = match mode {
            Mode::Front => "REVERIE_FRONT_CHILD_FIXTURE",
            Mode::Direct => "REVERIE_DIRECT_CHILD_FIXTURE",
        };
        let fixture =
            PathBuf::from(std::env::var_os(setting).expect("explicit compiled sealed TS fixture"));
        assert!(fixture.is_absolute() && fixture.is_file());
        let mut command = match mode {
            Mode::Front => {
                let executable = std::env::var_os("REVERIE_TEST_FRONT")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_reverie-front")));
                assert!(executable.is_absolute() && executable.is_file());
                let mut command = Command::new(executable);
                command
                    .arg("--node")
                    .arg(&node)
                    .arg("--entrypoint")
                    .arg(&fixture);
                command
            }
            Mode::Direct => {
                let mut command = Command::new(&node);
                command.arg(&fixture);
                command
            }
        };
        command.current_dir(fixture.parent().unwrap());
        command
            .env("FRONT_CHILD_HOST", "127.0.0.1")
            .env("FRONT_CHILD_PORT", "0");
        command
            .env_remove("FRONT_CHILD_BRIDGE_HOST")
            .env_remove("FRONT_CHILD_TLS");
        command.env("FRONT_CHILD_FINISH_MS", "5000");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().unwrap();
        let reader = BufReader::new(child.stderr.take().unwrap());
        let (tx, events) = mpsc::channel(64);
        let logs = tokio::spawn(collect_logs(reader, tx));
        let mut running = Self {
            child,
            events,
            logs,
            history: Vec::new(),
            port: 0,
        };
        loop {
            let event = running.event().await;
            if event["event"] == "service_ready" {
                running.port = event["port"]
                    .as_u64()
                    .expect("paired fixture ready port")
                    .try_into()
                    .unwrap();
                break;
            }
        }
        assert_ne!(running.port, 0);
        running
    }
    pub(crate) async fn event(&mut self) -> Value {
        let event = tokio::time::timeout(Duration::from_secs(15), self.events.recv())
            .await
            .expect("child lifecycle timeout")
            .expect("child lifecycle EOF");
        self.history.push(event.clone());
        event
    }
    pub(crate) fn available_events(&mut self) {
        while let Ok(event) = self.events.try_recv() {
            self.history.push(event);
        }
    }
    pub(crate) fn terminate(&self) {
        // This owned child has not been reaped; its PID cannot be recycled.
        let pid = self.child.id().expect("unreaped process");
        kill(Pid::from_raw(pid.try_into().unwrap()), Signal::SIGTERM).unwrap();
    }
    pub(crate) async fn stopped(&mut self) -> i32 {
        let status = tokio::time::timeout(Duration::from_secs(15), self.child.wait())
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), &mut self.logs)
            .await
            .unwrap()
            .unwrap();
        self.available_events();
        status
            .code()
            .expect("owned process preserves numerical status")
    }
    pub(crate) async fn stop(mut self) {
        self.terminate();
        assert_eq!(self.stopped().await, 0);
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.logs.abort();
    }
}
async fn collect_logs(reader: BufReader<tokio::process::ChildStderr>, output: mpsc::Sender<Value>) {
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        assert!(line.len() <= 8192, "fixture diagnostic bound");
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if output.send(value).await.is_err() {
            break;
        }
    }
}
pub(crate) fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
pub(crate) async fn open(
    running: &Running,
    method: &str,
    target: &str,
    body: &[u8],
) -> io::Result<TcpStream> {
    let mut socket = TcpStream::connect(("127.0.0.1", running.port)).await?;
    let head = format!(
        "{method} {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    socket.write_all(head.as_bytes()).await?;
    socket.write_all(body).await?;
    Ok(socket)
}
pub(crate) async fn request(
    running: &Running,
    method: &str,
    target: &str,
    body: &[u8],
) -> io::Result<Vec<u8>> {
    let mut socket = open(running, method, target, body).await?;
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), socket.read_to_end(&mut response)).await??;
    Ok(response)
}
pub(crate) fn body(response: &[u8]) -> &[u8] {
    assert!(
        response.starts_with(b"HTTP/1.1 200 "),
        "response head: {:?}",
        &response[..response.len().min(200)]
    );
    let split = response
        .windows(4)
        .position(|b| b == b"\r\n\r\n")
        .expect("HTTP head");
    &response[split + 4..]
}
