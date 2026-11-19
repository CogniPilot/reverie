use crate::{
    Lookup,
    configuration::page,
    registry::{Access, Registry},
    responses::{Body, Reply, status_reply},
};
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Request, Response, StatusCode, header, uri::PathAndQuery};
use http_body_util::{BodyExt, Empty};
use hyper::{
    body::{Body as _, Frame, Incoming},
    client::conn::http1,
};
use hyper_util::rt::TokioIo;
use std::{
    io,
    net::SocketAddr,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    net::TcpStream,
    sync::mpsc,
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};

const MAX_RESPONSE: u64 = 64 << 20;
const REQUEST_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "range",
    "if-range",
    "if-none-match",
    "if-modified-since",
];
const RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
];

pub(crate) async fn forward(
    registry: &Registry,
    lookup: &dyn Lookup,
    access: Access,
    request: Request<Incoming>,
    path: PathAndQuery,
) -> Reply {
    let deadline = access
        .identity
        .expires
        .min(Instant::now() + Duration::from_secs(30));
    let mut revoked = access.revocation.clone();
    let result = tokio::select! {
        biased;
        _ = revoked.changed() => Err(StatusCode::NOT_FOUND),
        result = timeout_at(deadline, open(registry, lookup, &access, request, path)) =>
            result.unwrap_or(Err(StatusCode::BAD_GATEWAY)),
    };
    match result {
        Ok((parts, incoming, connection)) => {
            Response::from_parts(parts, pump(incoming, connection, access, deadline))
        }
        Err(status) => status_reply(status),
    }
}

async fn open(
    registry: &Registry,
    lookup: &dyn Lookup,
    access: &Access,
    request: Request<Incoming>,
    path: PathAndQuery,
) -> Result<(http::response::Parts, Incoming, Connection), StatusCode> {
    let observed = lookup
        .resolve(&access.identity.session)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    if observed != access.identity.target {
        registry.invalidate(&access.identity);
        return Err(StatusCode::GONE);
    }
    let address = SocketAddr::from((observed.address, access.identity.port));
    let (mut client, connection) = connect(address)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let mut forwarded = Request::new(Empty::<Bytes>::new());
    *forwarded.uri_mut() = path.as_str().parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    *forwarded.method_mut() = request.method().clone();
    let headers = forwarded.headers_mut();
    copy_headers(request.headers(), headers, REQUEST_HEADERS);
    headers.insert(
        header::HOST,
        HeaderValue::from_str(&address.to_string()).expect("socket address is ASCII"),
    );
    headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
    headers.insert(
        header::ACCEPT_ENCODING,
        HeaderValue::from_static("identity"),
    );
    let response = timeout(Duration::from_secs(10), client.send_request(forwarded))
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    let (mut parts, incoming) = response.into_parts();
    parts.headers = response_headers(parts.status, &parts.headers, incoming.size_hint().upper())?;
    Ok((parts, incoming, connection))
}

fn response_headers(
    status: StatusCode,
    headers: &HeaderMap,
    size: Option<u64>,
) -> Result<HeaderMap, StatusCode> {
    if status.is_informational()
        || size.is_some_and(|size| size > MAX_RESPONSE)
        || headers
            .get_all(header::CONTENT_ENCODING)
            .iter()
            .any(|enc| !enc.as_bytes().eq_ignore_ascii_case(b"identity"))
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    if let Some(length) = headers.get(header::CONTENT_LENGTH) {
        match length
            .to_str()
            .ok()
            .and_then(|length| length.parse::<u64>().ok())
        {
            Some(length) if length <= MAX_RESPONSE => {}
            _ => return Err(StatusCode::BAD_GATEWAY),
        }
    }
    let mut out = HeaderMap::new();
    copy_headers(headers, &mut out, RESPONSE_HEADERS);
    if let Some(location) = headers.get(header::LOCATION) {
        let location = location
            .to_str()
            .ok()
            .and_then(page)
            .ok_or(StatusCode::BAD_GATEWAY)?;
        out.insert(
            header::LOCATION,
            HeaderValue::from_str(location.as_str()).map_err(|_| StatusCode::BAD_GATEWAY)?,
        );
    }
    Ok(out)
}

fn copy_headers(input: &HeaderMap, output: &mut HeaderMap, allowed: &[&'static str]) {
    for &name in allowed {
        for value in input.get_all(name) {
            output.append(http::header::HeaderName::from_static(name), value.clone());
        }
    }
}

struct Connection(JoinHandle<()>);
impl Drop for Connection {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn connect(
    address: SocketAddr,
) -> io::Result<(http1::SendRequest<Empty<Bytes>>, Connection)> {
    let socket = timeout(Duration::from_secs(3), TcpStream::connect(address)).await??;
    let (client, connection) = http1::handshake(TokioIo::new(socket))
        .await
        .map_err(io::Error::other)?;
    let drive = tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok((client, Connection(drive)))
}

enum Chunk {
    Data(Bytes),
    Complete,
}

struct Stream {
    receiver: mpsc::Receiver<Chunk>,
    finished: bool,
    revocation: tokio::sync::watch::Receiver<()>,
}

impl hyper::body::Body for Stream {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        if self.finished {
            return Poll::Ready(None);
        }
        if self.revocation.has_changed().is_err() {
            self.finished = true;
            return Poll::Ready(Some(Err(io::Error::other("preview was revoked"))));
        }
        match self.receiver.poll_recv(cx) {
            Poll::Ready(Some(Chunk::Data(bytes))) => Poll::Ready(Some(Ok(Frame::data(bytes)))),
            Poll::Ready(Some(Chunk::Complete)) => {
                self.finished = true;
                Poll::Ready(None)
            }
            Poll::Ready(None) => {
                self.finished = true;
                Poll::Ready(Some(Err(io::Error::other(
                    "preview stream was interrupted",
                ))))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

fn pump(incoming: Incoming, connection: Connection, access: Access, deadline: Instant) -> Body {
    let (sender, receiver) = mpsc::channel(1);
    let revocation = access.revocation.clone();
    tokio::spawn(async move {
        let mut revoked = access.revocation.clone();
        tokio::select! {
            biased;
            _ = revoked.changed() => {}
            _ = sender.closed() => {}
            _ = timeout_at(deadline, transfer(incoming, &sender)) => {}
        }
        drop((connection, access));
    });
    Stream {
        receiver,
        finished: false,
        revocation,
    }
    .boxed_unsync()
}

async fn transfer(mut incoming: Incoming, sender: &mpsc::Sender<Chunk>) {
    let mut received = 0;
    loop {
        let frame = match timeout(Duration::from_secs(10), incoming.frame()).await {
            Ok(Some(Ok(frame))) => frame,
            Ok(None) => break,
            _ => return,
        };
        let Ok(bytes) = frame.into_data() else {
            continue;
        };
        received += bytes.len() as u64;
        if received > MAX_RESPONSE || sender.send(Chunk::Data(bytes)).await.is_err() {
            return;
        }
    }
    let _ = sender.send(Chunk::Complete).await;
}
