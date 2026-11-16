//! One request, no automatic replay. Credentials never appear in a URL or argv.
use crate::{Error, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Read,
    net::SocketAddr,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    time::Duration,
};
use tokio::net::TcpStream;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialFile {
    version: u8,
    token: String,
}
pub fn credential(path: &Path) -> Result<String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| Error::Unauthorized)?;
    let meta = file.metadata().map_err(|_| Error::Unauthorized)?;
    if !meta.is_file()
        || meta.uid() != nix::unistd::geteuid().as_raw()
        || meta.mode() & 0o7777 != 0o600
        || meta.nlink() != 1
        || meta.len() > 4096
    {
        return Err(Error::Unauthorized);
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Unauthorized)?;
    let named = fs::symlink_metadata(path).map_err(|_| Error::Unauthorized)?;
    let after = file.metadata().map_err(|_| Error::Unauthorized)?;
    let closed = nix::unistd::close(file).map_err(|_| Error::Unauthorized);
    if (named.dev(), named.ino()) != (meta.dev(), meta.ino())
        || after.len() != meta.len()
        || bytes.len() > 4096
    {
        return Err(Error::Unauthorized);
    }
    closed?;
    let value: CredentialFile = serde_json::from_slice(&bytes).map_err(|_| Error::Unauthorized)?;
    if value.version != 1 {
        return Err(Error::Unauthorized);
    }
    Ok(value.token)
}
pub async fn call(
    address: SocketAddr,
    token: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value> {
    if !address.ip().is_loopback() {
        return Err(Error::Forbidden);
    }
    tokio::time::timeout(
        Duration::from_secs(5),
        send(address, token, method, path, body),
    )
    .await
    .map_err(|_| Error::PublicationUnconfirmed)?
}
async fn send(
    address: SocketAddr,
    token: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value> {
    let bytes = body
        .map(|value| serde_json::to_vec(&value).map_err(|_| Error::Invalid))
        .transpose()?
        .unwrap_or_default();
    if bytes.len() > 16384 {
        return Err(Error::Invalid);
    }
    let stream = TcpStream::connect(address)
        .await
        .map_err(|_| Error::PublicationUnconfirmed)?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| Error::PublicationUnconfirmed)?;
    let connection = tokio::spawn(connection);
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", address.to_string())
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(bytes)))
        .map_err(|_| Error::Invalid)?;
    let response = sender
        .send_request(request)
        .await
        .map_err(|_| Error::PublicationUnconfirmed)?;
    let mut body = response.into_body();
    let mut raw = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| Error::PublicationUnconfirmed)?;
        if let Some(data) = frame.data_ref() {
            if raw.len().saturating_add(data.len()) > 1048576 {
                return Err(Error::PublicationUnconfirmed);
            }
            raw.extend_from_slice(data);
        }
    }
    drop(sender);
    let _ = connection.await;
    serde_json::from_slice(&raw).map_err(|_| Error::PublicationUnconfirmed)
}
