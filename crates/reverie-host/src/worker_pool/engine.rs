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
    effect_reply: std::sync::Mutex<Option<(u16, Vec<u8>)>>,
}
impl EngineObserver {
    pub(super) fn inspect(&self, id: &str) -> Result<Vec<u8>> {
        need(
            reverie_contracts::worker_pool::hex_id(id),
            "WORKER_POOL_CONTAINER_ID",
        )?;
        self.read(&format!("/containers/{id}/json"))
    }
    pub(super) fn inventory(&self) -> Result<Vec<u8>> {
        self.read("/containers/json?all=1")
    }
    pub(super) fn create_anchor(&self, policy: &WorkerPoolPolicy, digest: &str) -> Result<Vec<u8>> {
        let body = serde_json::to_vec(&serde_json::json!({"Image":policy.anchor_image,"User":format!("{}:{}",policy.broker_uid,policy.broker_gid),"Entrypoint":["/bin/sleep"],"Cmd":["infinity"],"Env":["PATH=/bin","LANG=C.UTF-8"],"Labels":{"reverie.pool.anchor":policy.deployment,"reverie.pool.birth-policy":digest},"HostConfig":{"CgroupParent":policy.parent_slice(),"ReadonlyRootfs":true,"NetworkMode":"none","CapDrop":["ALL"],"SecurityOpt":["no-new-privileges:true"],"Memory":67108864,"MemorySwap":67108864,"PidsLimit":16,"CpuShares":2,"NanoCpus":0,"CpusetCpus":policy.cpu_list(),"RestartPolicy":{"Name":"no"}}})).map_err(|_|PoolError::Refused("WORKER_POOL_ANCHOR_BODY"))?;
        self.effect(
            &format!("/containers/create?name={}", policy.anchor_name()),
            &body,
            201,
        )
    }
    pub(super) fn start_anchor(&self, id: &str) -> Result<()> {
        need(
            reverie_contracts::worker_pool::hex_id(id),
            "WORKER_POOL_ANCHOR_IDENTITY",
        )?;
        self.effect(&format!("/containers/{id}/start"), &[], 204)
            .map(|_| ())
    }
    fn effect(&self, target: &str, body: &[u8], expected: u16) -> Result<Vec<u8>> {
        need(
            !self.opaque.load(Ordering::Acquire) && socket_identity()? == self.socket_identity,
            "WORKER_POOL_ENGINE_CLOSE_UNKNOWN",
        )?;
        let mut retained = self
            .effect_reply
            .lock()
            .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_REPLY_RETAINED"))?;
        *retained = None;
        let result =
            self.runtime
                .block_on(self.exchange(target, "POST", body, Some(&mut retained)));
        if result.is_err() {
            self.opaque.store(true, Ordering::Release);
        }
        let (status, raw) = result?;
        need(
            socket_identity()? == self.socket_identity,
            "WORKER_POOL_ENGINE_SOCKET_CHANGED",
        )?;
        if status != expected {
            // An effect result is never retried. A daemon 5xx may have acted.
            if status >= 500 {
                self.opaque.store(true, Ordering::Release);
            }
            return Err(PoolError::Refused("WORKER_POOL_ENGINE_EFFECT_REFUSED"));
        }
        Ok(raw)
    }
    #[cfg(test)]
    pub(super) fn unconnected_test_owner() -> Self {
        Self {
            runtime: tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap(),
            socket_identity: (0, 0),
            opaque: AtomicBool::new(false),
            effect_reply: std::sync::Mutex::new(None),
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
            effect_reply: std::sync::Mutex::new(None),
        })
    }
    pub(super) fn verify(
        &self,
        policy: &WorkerPoolPolicy,
        process: &super::namespace::ControllerProcessObservation,
        birth_digest: [u8; 32],
        service_v2: bool,
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
        let validate = if service_v2 {
            reverie_contracts::worker_pool::validate_controller_service_v2_inspection
        } else {
            reverie_contracts::worker_pool::validate_controller_inspection
        };
        validate(&spec, policy, &process.container, process.pid, &digest)
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
        let result = self
            .runtime
            .block_on(self.exchange(target, "GET", &[], None))
            .and_then(|(status, raw)| {
                need(status == 200, "WORKER_POOL_ENGINE_REFUSED")?;
                Ok(raw)
            });
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
    async fn exchange(
        &self,
        target: &str,
        method: &'static str,
        body: &[u8],
        retained: Option<&mut Option<(u16, Vec<u8>)>>,
    ) -> Result<(u16, Vec<u8>)> {
        let mut stream = tokio::time::timeout(Duration::from_secs(2), UnixStream::connect(SOCKET))
            .await
            .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_CONNECT_TIMEOUT"))??;
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            query(&mut stream, target, method, body),
        )
        .await
        .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_READ_TIMEOUT"))
        .and_then(|value| value);
        // Preserve the original daemon response BEFORE any checked close or
        // later CID/status parse. The allocation below clones retained bytes.
        let result = result.map(|reply| {
            if let Some(slot) = retained {
                *slot = Some(reply);
                slot.as_ref().expect("original response retained").clone()
            } else {
                reply
            }
        });
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
async fn query(
    stream: &mut UnixStream,
    target: &str,
    method: &'static str,
    body: &[u8],
) -> Result<(u16, Vec<u8>)> {
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
    let response = send(&mut sender, target, method, body);
    tokio::pin!(response);
    tokio::select! {
        biased;
        result = &mut response => result,
        _closed = &mut connection => response.await,
    }
}
async fn send(
    sender: &mut http1::SendRequest<Full<Bytes>>,
    target: &str,
    method: &'static str,
    payload: &[u8],
) -> Result<(u16, Vec<u8>)> {
    let request = Request::builder()
        .method(method)
        .uri(target)
        .header("host", "localhost")
        .header("connection", "close")
        .header("content-type", "application/json")
        .body(Full::new(Bytes::copy_from_slice(payload)))
        .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_HTTP"))?;
    let response = sender
        .send_request(request)
        .await
        .map_err(|_| PoolError::Refused("WORKER_POOL_ENGINE_REPLY_UNKNOWN"))?;
    let status = response.status().as_u16();
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
    Ok((status, raw))
}
