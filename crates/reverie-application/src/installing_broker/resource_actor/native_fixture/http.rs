//! Owning-test orchestration only. Fixed local Docker/website endpoints; no
//! production engine interface, authentication or native proof is supplied.
use super::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, client::conn::http1};
use hyper_util::rt::TokioIo;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpStream, UnixStream},
    runtime::Runtime,
};

pub(super) struct Http(Runtime);
pub(super) struct Response {
    pub(super) value: Value,
    pub(super) cookie: Option<String>,
}
impl Http {
    pub(super) fn new() -> CaseResult<Self> {
        Ok(Self(Runtime::new().map_err(reason)?))
    }
    pub(super) fn docker(
        &self,
        method: &str,
        route: &str,
        body: Option<&Value>,
    ) -> CaseResult<Value> {
        self.0.block_on(async {
            tokio::time::timeout(Duration::from_secs(30), async {
                let stream = UnixStream::connect("/var/run/docker.sock")
                    .await
                    .map_err(reason)?;
                let peer = nix::sys::socket::getsockopt(
                    &stream,
                    nix::sys::socket::sockopt::PeerCredentials,
                )
                .map_err(reason)?;
                require(
                    peer.uid() == 0,
                    "fixture requires actual system Docker peer",
                )?;
                exchange(stream, "localhost", method, route, None, body)
                    .await
                    .map(|r| r.value)
            })
            .await
            .map_err(reason)?
        })
    }
    pub(super) fn website(
        &self,
        port: u16,
        method: &str,
        route: &str,
        cookie: Option<&str>,
        body: Option<&Value>,
    ) -> CaseResult<Response> {
        self.0.block_on(async {
            tokio::time::timeout(Duration::from_secs(10), async {
                let stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
                    .await
                    .map_err(reason)?;
                exchange(
                    stream,
                    &format!("127.0.0.1:{port}"),
                    method,
                    route,
                    cookie,
                    body,
                )
                .await
            })
            .await
            .map_err(reason)?
        })
    }
}
async fn exchange<S>(
    stream: S,
    host: &str,
    method: &str,
    route: &str,
    cookie: Option<&str>,
    body: Option<&Value>,
) -> CaseResult<Response>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, driver) = http1::handshake(TokioIo::new(stream))
        .await
        .map_err(reason)?;
    tokio::pin!(driver);
    let raw = body
        .map(serde_json::to_vec)
        .transpose()
        .map_err(reason)?
        .unwrap_or_default();
    let mut request = Request::builder()
        .method(method)
        .uri(route)
        .header("host", host)
        .header("origin", format!("http://{host}"))
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let request = request.body(Full::new(Bytes::from(raw))).map_err(reason)?;
    let body = async {
        let response = sender.send_request(request).await.map_err(reason)?;
        let status = response.status();
        let cookie = response
            .headers()
            .get("set-cookie")
            .map(|v| {
                v.to_str()
                    .map(|s| s.split(';').next().unwrap_or("").to_owned())
            })
            .transpose()
            .map_err(reason)?;
        let mut body = response.into_body();
        let mut bytes = Vec::new();
        while let Some(frame) = body.frame().await {
            if let Ok(data) = frame.map_err(reason)?.into_data() {
                require(
                    bytes.len().saturating_add(data.len()) <= 2 * 1024 * 1024,
                    "fixture body bound",
                )?;
                bytes.extend_from_slice(&data);
            }
        }
        require(
            status.is_success(),
            &format!(
                "owned fixture HTTP refused: {status}; body: {}",
                String::from_utf8_lossy(&bytes[..bytes.len().min(4096)])
            ),
        )?;
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(reason)?
        };
        Ok(Response { value, cookie })
    };
    tokio::pin!(body);
    // The exact socket driver and request stay in this timeout scope. No
    // detached task can emit a late mutation or result after an unknown reply.
    tokio::select! { biased; result = &mut body => result, _closed = &mut driver => body.await }
}
