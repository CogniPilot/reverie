//! Fixed root-peer Engine readback for the controller's OWN native identity.
//! Hyper owns HTTP parsing. The socket stays outside/borrowed by its driver,
//! then passes through the existing checked-close owner on every result.
use super::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, client::conn::http1};
use hyper_util::rt::TokioIo;
use std::{
    fs::{self, File},
    os::{
        fd::OwnedFd,
        unix::fs::{FileTypeExt, MetadataExt},
    },
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::{net::UnixStream, runtime::Runtime};

const SOCKET: &str = "/run/reverie-engine.sock";

pub(super) struct EngineObserver {
    runtime: Runtime,
    socket_identity: (u64, u64),
    opaque: AtomicBool,
}
impl EngineObserver {
    #[cfg(test)]
    pub(super) fn unconnected_test_owner() -> Self {
        Self {
            runtime: tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap(),
            socket_identity: (0, 0),
            opaque: AtomicBool::new(false),
        }
    }
    pub(super) fn require_closed(&self) -> Result<()> {
        need(
            !self.opaque.load(Ordering::Acquire),
            "WORKER_POOL_ENGINE_CLOSE_UNKNOWN",
        )
    }
    pub(super) fn capture() -> Result<Self> {
        let socket_identity = socket_identity()?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        Ok(Self {
            runtime,
            socket_identity,
            opaque: AtomicBool::new(false),
        })
    }
    pub(super) fn verify(
        &self,
        policy: &WorkerPoolPolicy,
        process: &super::namespace::ControllerProcessObservation,
        birth_digest: [u8; 32],
    ) -> Result<()> {
        need(
            !self.opaque.load(Ordering::Acquire),
            "WORKER_POOL_ENGINE_CLOSE_UNKNOWN",
        )?;
        let info = self.read("/info")?;
        reverie_contracts::worker_pool::validate_engine_information(&info, policy)
            .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_IDENTITY"))?;
        let spec = self.read(&format!("/containers/{}/json", process.container))?;
        let digest: String = birth_digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        reverie_contracts::worker_pool::validate_controller_inspection(
            &spec,
            policy,
            &process.container,
            process.pid,
            &digest,
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_CONTROLLER_SPEC"))?;
        let target = format!("/containers/{}/json", policy.website_container);
        let website = self.read(&target)?;
        let pid = reverie_contracts::worker_pool::website_process_data(
            &website,
            &policy.website_container,
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_WEBSITE_IDENTITY"))?;
        if let Some(pid) = pid {
            let group = super::directory::bounded_path(&format!("/proc/{pid}/cgroup"), 4096)?;
            let parent = format!("0::/{}", policy.parent_cgroup_relative());
            need(
                !group.trim().starts_with(&format!("{parent}/")) && group.trim() != parent,
                "WORKER_POOL_WEBSITE_INSIDE_POOL",
            )?;
        }
        need(
            self.read(&target)? == website,
            "WORKER_POOL_WEBSITE_CHANGED",
        )
    }
    pub(super) fn verify_anchor(
        &self,
        policy: &WorkerPoolPolicy,
        id: &str,
        pid: u32,
        digest: [u8; 32],
    ) -> Result<()> {
        need(
            reverie_contracts::worker_pool::hex_id(id),
            "WORKER_POOL_ANCHOR_IDENTITY",
        )?;
        let raw = self.read(&format!("/containers/{id}/json"))?;
        let text: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        reverie_contracts::worker_pool::validate_anchor_inspection(&raw, policy, id, pid, &text)
            .map_err(|_| PoolError::Refused("WORKER_POOL_ANCHOR_SPEC"))
    }
    fn read(&self, target: &str) -> Result<Vec<u8>> {
        need(
            socket_identity()? == self.socket_identity,
            "WORKER_POOL_ENGINE_SOCKET_CHANGED",
        )?;
        let result = self.runtime.block_on(self.exchange(target));
        if result.is_err() {
            self.opaque.store(true, Ordering::Release);
        }
        let bytes = result?;
        need(
            socket_identity()? == self.socket_identity,
            "WORKER_POOL_ENGINE_SOCKET_CHANGED",
        )?;
        Ok(bytes)
    }
    async fn exchange(&self, target: &str) -> Result<Vec<u8>> {
        let mut stream = tokio::time::timeout(Duration::from_secs(2), UnixStream::connect(SOCKET))
            .await
            .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_CONNECT_TIMEOUT"))??;
        let result = tokio::time::timeout(Duration::from_secs(2), query(&mut stream, target))
            .await
            .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_READ_TIMEOUT"))
            .and_then(|value| value);
        let closed = match stream.into_std() {
            Ok(stream) => {
                crate::native::close(File::from(OwnedFd::from(stream))).map_err(Into::into)
            }
            // Conversion consumed the only Tokio stream; its default Drop is
            // not a checked native close receipt.
            Err(error) => Err(PoolError::MetadataClose(Box::new(error.into()))),
        };
        finalized(result, closed)
    }
}
fn socket_identity() -> Result<(u64, u64)> {
    let metadata = fs::symlink_metadata(SOCKET)?;
    need(
        metadata.file_type().is_socket()
            && metadata.uid() == 0
            && metadata.nlink() == 1
            && metadata.mode() & 0o002 == 0,
        "WORKER_POOL_ROOT_ENGINE_SOCKET_REQUIRED",
    )?;
    Ok((metadata.dev(), metadata.ino()))
}
async fn query(stream: &mut UnixStream, target: &str) -> Result<Vec<u8>> {
    let peer = nix::sys::socket::getsockopt(&*stream, nix::sys::socket::sockopt::PeerCredentials)
        .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_PEER_UNKNOWN"))?;
    need(
        peer.uid() == 0 && peer.pid() > 1,
        "WORKER_POOL_ENGINE_ROOT_PEER_REQUIRED",
    )?;
    let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_HTTP"))?;
    tokio::pin!(connection);
    let response = send(&mut sender, target);
    tokio::pin!(response);
    tokio::select! {
        biased;
        result = &mut response => result,
        _closed = &mut connection => response.await,
    }
}
async fn send(sender: &mut http1::SendRequest<Full<Bytes>>, target: &str) -> Result<Vec<u8>> {
    let request = Request::builder()
        .method("GET")
        .uri(target)
        .header("host", "localhost")
        .header("connection", "close")
        .body(Full::new(Bytes::new()))
        .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_HTTP"))?;
    let response = sender
        .send_request(request)
        .await
        .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_REPLY_UNKNOWN"))?;
    need(
        response.status().as_u16() == 200,
        "WORKER_POOL_ENGINE_REFUSED",
    )?;
    let mut body = response.into_body();
    let mut raw = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_REPLY_UNKNOWN"))?;
        if let Ok(data) = frame.into_data() {
            need(
                raw.len().saturating_add(data.len()) <= 1_048_576,
                "WORKER_POOL_ENGINE_REPLY_BOUND",
            )?;
            raw.extend_from_slice(&data);
        }
    }
    Ok(raw)
}
