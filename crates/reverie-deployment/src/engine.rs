//! Fixed Docker Engine HTTP adapter. One request, no automatic mutation retry.
use super::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, client::conn::http1};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{net::UnixStream, runtime::Runtime};

#[cfg(test)]
mod tests;

pub(super) struct Engine {
    socket: PathBuf,
    runtime: Runtime,
}
impl Engine {
    pub(super) fn new(socket: &Path) -> Result<Self> {
        use std::os::unix::fs::FileTypeExt;
        require(
            std::fs::metadata(socket)?.file_type().is_socket(),
            "DEPLOYMENT_ENGINE_SOCKET_REQUIRED",
        )?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        Ok(Self {
            socket: socket.to_owned(),
            runtime,
        })
    }
    pub(super) fn json(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        self.json_with_policy(method, path, body, Duration::from_secs(75), 0)
    }
    fn json_with_policy(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
        expected_uid: u32,
    ) -> Result<Value> {
        self.runtime.block_on(async {
            tokio::time::timeout(timeout, self.exchange(method, path, body, expected_uid))
                .await
                .map_err(|_| DeploymentError::new("DEPLOYMENT_ENGINE_RESPONSE_UNKNOWN"))?
        })
    }
    async fn exchange(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        expected_uid: u32,
    ) -> Result<Value> {
        let stream = UnixStream::connect(&self.socket).await?;
        let peer =
            nix::sys::socket::getsockopt(&stream, nix::sys::socket::sockopt::PeerCredentials)
                .map_err(|_| DeploymentError::new("DEPLOYMENT_ENGINE_PEER_UNKNOWN"))?;
        require(
            peer.uid() == expected_uid,
            "DEPLOYMENT_ENGINE_PEER_NOT_ROOT",
        )?;
        let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|_| DeploymentError::new("DEPLOYMENT_ENGINE_TRANSPORT"))?;
        // Both futures belong to this scope. Timeout drops the socket driver
        // as well as the sender; no detached task survives to send later.
        tokio::pin!(connection);
        let request = self.send(&mut sender, method, path, body);
        tokio::pin!(request);
        tokio::select! {
            biased;
            result = &mut request => result,
            // EOF can deliver the final response and complete the driver in
            // the same poll. Drain that same queued response before deciding
            // whether it was lost; the outer timeout still owns both futures.
            _closed = &mut connection => request.await,
        }
    }
    async fn send(
        &self,
        sender: &mut http1::SendRequest<Full<Bytes>>,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let raw = body
            .map(serde_json::to_vec)
            .transpose()?
            .unwrap_or_default();
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "localhost")
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(raw)))
            .map_err(|_| DeploymentError::new("DEPLOYMENT_ENGINE_REQUEST"))?;
        let response = sender
            .send_request(request)
            .await
            .map_err(|_| DeploymentError::new("DEPLOYMENT_ENGINE_RESPONSE_UNKNOWN"))?;
        let success = response.status().is_success();
        let mut body = response.into_body();
        let mut bytes = Vec::new();
        while let Some(frame) = body.frame().await {
            let frame =
                frame.map_err(|_| DeploymentError::new("DEPLOYMENT_ENGINE_RESPONSE_UNKNOWN"))?;
            if let Ok(data) = frame.into_data() {
                require(
                    bytes.len().saturating_add(data.len()) <= 16 * 1024 * 1024,
                    "DEPLOYMENT_ENGINE_RESPONSE_LIMIT",
                )?;
                bytes.extend_from_slice(&data);
            }
        }
        require(success, "DEPLOYMENT_ENGINE_REFUSED")?;
        if bytes.is_empty() {
            Ok(Value::Null)
        } else {
            Ok(serde_json::from_slice(&bytes)?)
        }
    }
    pub(super) fn container(&self, id: &str) -> Result<Value> {
        self.json("GET", &format!("/containers/{id}/json"), None)
    }
    pub(super) fn image(&self, id: &str) -> Result<Value> {
        self.json("GET", &format!("/images/{id}/json"), None)
    }
    pub(super) fn stop(&self, id: &str) -> Result<()> {
        self.json("POST", &format!("/containers/{id}/stop?t=30"), None)
            .map(|_| ())
    }
    pub(super) fn start(&self, id: &str) -> Result<()> {
        self.json("POST", &format!("/containers/{id}/start"), None)
            .map(|_| ())
    }
    pub(super) fn rename(&self, id: &str, name: &str) -> Result<()> {
        self.json(
            "POST",
            &format!("/containers/{id}/rename?name={name}"),
            None,
        )
        .map(|_| ())
    }
}
