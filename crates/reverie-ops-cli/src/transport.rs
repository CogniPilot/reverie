//! One bounded POST to the installed office phone. No redirects, retries,
//! proxy environment, caller identity headers, arbitrary routes or TLS roots.
use crate::{Result, Unavailable, address::OfficePhone};
use bytes::Bytes;
use http::{Method, Request};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use reverie_contracts::ops_command::{MAX_REPLY_BYTES, OpsCommand, OpsReply};
use reverie_http::{TimedIo, http1_builder, send_response};
use std::time::Duration;
use tokio::net::TcpStream;
const TIMEOUT: Duration = Duration::from_secs(8);

pub(crate) fn call(phone: OfficePhone, command: &OpsCommand) -> Result<OpsReply> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| Unavailable)?;
    runtime.block_on(exchange(&phone, command.canonical_bytes()))
}
async fn connect(phone: &OfficePhone) -> Result<TcpStream> {
    // Match socket.create_connection: resolution occurs outside its timeout;
    // each address gets the original socket-connect budget in resolver order.
    let addresses = tokio::net::lookup_host((phone.host(), phone.port()))
        .await
        .map_err(|_| Unavailable)?;
    for address in addresses {
        if let Ok(Ok(stream)) = tokio::time::timeout(TIMEOUT, TcpStream::connect(address)).await {
            return Ok(stream);
        }
    }
    Err(Unavailable)
}
async fn exchange(phone: &OfficePhone, bytes: &[u8]) -> Result<OpsReply> {
    let stream = TimedIo::new(Box::new(connect(phone).await?), TIMEOUT, bytes.len());
    let (mut sender, connection) = http1_builder()
        .handshake(TokioIo::new(stream))
        .await
        .map_err(|_| Unavailable)?;
    let driver = tokio::spawn(connection);
    let result = response(&mut sender, phone, bytes).await;
    // Always consume this one transport task, including negative reply/parse
    // paths. This never retries the POST or proves a server effect rolled back.
    driver.abort();
    let _ = driver.await;
    result
}
async fn response(
    sender: &mut hyper::client::conn::http1::SendRequest<Full<Bytes>>,
    phone: &OfficePhone,
    bytes: &[u8],
) -> Result<OpsReply> {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/ops")
        .header("Host", phone.host_header())
        .header("Content-Type", "application/json")
        .header("Content-Length", bytes.len())
        .header("Accept-Encoding", "identity")
        .body(Full::new(Bytes::copy_from_slice(bytes)))
        .map_err(|_| Unavailable)?;
    let mut body = send_response(sender, request, true)
        .await
        .map_err(|_| Unavailable)?
        .into_body();
    let mut raw = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| Unavailable)?;
        if let Ok(data) = frame.into_data() {
            if data.len() > MAX_REPLY_BYTES.saturating_sub(raw.len()) {
                return Err(Unavailable);
            }
            raw.extend_from_slice(&data);
        }
    }
    OpsReply::decode(&raw).map_err(|_| Unavailable)
}
