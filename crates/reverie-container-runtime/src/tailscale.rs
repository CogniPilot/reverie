use crate::config::Result;
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use reverie_core::private_access::{ENABLED, HOSTNAME, WEB_PORT};
use serde_json::Value;
use std::fs::{self, DirBuilder};
use std::net::{Ipv4Addr, SocketAddrV4};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

const BINARIES: &str = "/usr/local/libexec/reverie-tailscale";
const OWNER_REPLY_LIMIT: u64 = 8 * 1024;

pub(crate) struct Access {
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

struct Settings {
    data: PathBuf,
    hostname: String,
    port: u16,
}

impl Settings {
    fn from_env() -> Result<Self> {
        if std::env::var("REVERIE_CONTAINER").as_deref() != Ok("1") {
            return Err("private access requires a Reverie container".into());
        }
        let data = std::env::var_os("REVERIE_DATA")
            .map_or_else(|| PathBuf::from("/instances/default"), PathBuf::from);
        if !data.is_absolute() {
            return Err("the instance directory must be absolute".into());
        }
        let port = std::env::var(WEB_PORT.key)
            .unwrap_or_else(|_| WEB_PORT.default.into())
            .parse::<u16>()?;
        if port == 0 {
            return Err("the private HTTPS target needs a web port".into());
        }
        Ok(Self {
            data,
            hostname: std::env::var(HOSTNAME.key).unwrap_or_else(|_| HOSTNAME.default.into()),
            port,
        })
    }

    fn state(&self, socket_dir: &Path) -> Result<PathBuf> {
        let state = self.data.join("tailscale");
        DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(&state)?;
        let metadata = fs::symlink_metadata(&state)?;
        if !metadata.is_dir()
            || metadata.uid() != fs::metadata(socket_dir)?.uid()
            || metadata.mode() & 0o077 != 0
        {
            return Err("Tailscale state must be an owner-only directory".into());
        }
        Ok(state)
    }
}

pub(crate) fn start(directory: &Path) -> Option<Access> {
    if std::env::var(ENABLED.key).as_deref() != Ok("1") {
        return None;
    }
    let (shutdown, stopping) = oneshot::channel();
    let directory = directory.to_path_buf();
    let task = tokio::spawn(async move {
        if let Err(error) = run(&directory, stopping).await {
            eprintln!("[Tailscale] Private access failed: {error}");
        }
    });
    Some(Access { shutdown, task })
}

pub(crate) async fn stop(access: Option<Access>) {
    if let Some(access) = access {
        let _ = access.shutdown.send(());
        let _ = access.task.await;
    }
}

fn owner_is_ready(reply: &[u8]) -> bool {
    let Ok(reply) = std::str::from_utf8(reply) else {
        return false;
    };
    let Some((headers, body)) = reply.split_once("\r\n\r\n") else {
        return false;
    };
    if !headers.starts_with("HTTP/1.1 200 ") {
        return false;
    }
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    value["success"] == true
        && value["data"]["configured"] == true
        && value["data"]["policy"] == "enforce"
}

async fn owner_probe(port: u16) -> Result<bool> {
    let mut socket = TcpStream::connect(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await?;
    socket
        .write_all(
            b"GET /api/owner/status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .await?;
    let mut reply = Vec::new();
    socket
        .take(OWNER_REPLY_LIMIT + 1)
        .read_to_end(&mut reply)
        .await?;
    Ok(reply.len() <= OWNER_REPLY_LIMIT as usize && owner_is_ready(&reply))
}

async fn owner_ready(port: u16) -> bool {
    matches!(
        timeout(Duration::from_secs(2), owner_probe(port)).await,
        Ok(Ok(true))
    )
}

async fn wait_for_socket(path: &Path) -> Result<()> {
    for _ in 0..100 {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_socket() => return Ok(()),
            Ok(_) => return Err("the Tailscale socket path is occupied".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        sleep(Duration::from_millis(100)).await;
    }
    Err("Tailscale did not open its private socket".into())
}

async fn cli(
    executable: &Path,
    socket: &Path,
    operation: &str,
    arguments: &[String],
) -> Result<()> {
    let status = Command::new(executable)
        .arg("--socket")
        .arg(socket)
        .arg(operation)
        .args(arguments)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await?;
    if !status.success() {
        return Err(format!("tailscale {operation} exited with {status}").into());
    }
    Ok(())
}

async fn serve(executable: &Path, socket: &Path, settings: &Settings) -> Result<()> {
    wait_for_socket(socket).await?;
    cli(
        executable,
        socket,
        "up",
        &[
            "--accept-dns=false".into(),
            format!("--hostname={}", settings.hostname),
        ],
    )
    .await?;
    wait_for_owner(settings.port).await;
    cli(
        executable,
        socket,
        "serve",
        &[
            "--https=443".into(),
            format!("http://127.0.0.1:{}", settings.port),
        ],
    )
    .await
}

async fn stop_daemon(daemon: &mut Child) {
    if let Some(id) = daemon.id().and_then(|id| i32::try_from(id).ok()) {
        let _ = kill(Pid::from_raw(id), Signal::SIGTERM);
    }
    if timeout(Duration::from_secs(2), daemon.wait())
        .await
        .is_err()
    {
        let _ = daemon.kill().await;
    }
}

async fn wait_for_owner(port: u16) {
    if !owner_ready(port).await {
        println!("[Tailscale] Waiting for the local office to confirm owner authentication.");
        loop {
            sleep(Duration::from_secs(2)).await;
            if owner_ready(port).await {
                break;
            }
        }
    }
}

async fn run(directory: &Path, mut stopping: oneshot::Receiver<()>) -> Result<()> {
    let settings = Settings::from_env()?;
    tokio::select! {
        () = wait_for_owner(settings.port) => {}
        _ = &mut stopping => return Ok(()),
    }
    let state = settings.state(directory)?;
    let socket = directory.join("tailscaled.sock");
    let mut daemon = Command::new(Path::new(BINARIES).join("tailscaled"))
        .arg("--tun=userspace-networking")
        .arg("--statedir")
        .arg(state)
        .arg("--socket")
        .arg(&socket)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let executable = Path::new(BINARIES).join("tailscale");
    let result = tokio::select! {
        result = serve(&executable, &socket, &settings) => result,
        result = daemon.wait() => Err(format!("tailscaled exited with {}", result?).into()),
        _ = stopping => Ok(()),
    };
    stop_daemon(&mut daemon).await;
    result
}

#[cfg(test)]
mod tests {
    use super::{Settings, owner_is_ready, serve};
    use crate::RuntimeDirectory;
    use std::{path::Path, time::Duration};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, UnixListener};

    async fn reply(owner: &TcpListener, response: &str) {
        let (stream, _) = owner.accept().await.unwrap();
        let mut stream = BufReader::new(stream);
        let mut request = String::new();
        while !request.ends_with("\r\n\r\n") {
            assert!(stream.read_line(&mut request).await.unwrap() > 0);
        }
        assert!(request.starts_with("GET /api/owner/status "));
        stream
            .get_mut()
            .write_all(response.as_bytes())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn serving_waits_out_a_transient_owner_failure_after_login() {
        let directory = RuntimeDirectory::new().unwrap();
        let socket = directory.0.join("daemon.sock");
        let _daemon = UnixListener::bind(&socket).unwrap();
        let owner = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let settings = Settings {
            data: directory.0.clone(),
            hostname: "fixture".into(),
            port: owner.local_addr().unwrap().port(),
        };
        let replies = async {
            reply(
                &owner,
                "HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n",
            )
            .await;
            reply(&owner, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"success\":true,\"data\":{\"configured\":true,\"policy\":\"enforce\"}}").await;
        };
        tokio::time::timeout(Duration::from_secs(10), async {
            let (served, ()) = tokio::join!(serve(Path::new("true"), &socket, &settings), replies);
            served.unwrap();
        })
        .await
        .unwrap();
    }

    #[test]
    fn serves_only_with_an_enforced_owner() {
        let raw = |status: &str, body: &str| {
            format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\r\n{body}")
        };
        let ready = r#"{"success":true,"data":{"configured":true,"policy":"enforce"}}"#;
        assert!(owner_is_ready(raw("200 OK", ready).as_bytes()));
        assert!(!owner_is_ready(raw("302 Found", ready).as_bytes()));
        assert!(!owner_is_ready(
            raw("200 OK", &ready.replace("enforce", "optional")).as_bytes()
        ));
        assert!(!owner_is_ready(
            raw(
                "200 OK",
                &ready.replace("configured\":true", "configured\":false")
            )
            .as_bytes()
        ));
        assert!(!owner_is_ready(b"HTTP/1.1 200 OK\r\n\r\n{"));
    }
}
