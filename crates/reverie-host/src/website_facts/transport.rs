//! Hyper owns HTTP framing. AsyncFd and the driver borrow the sole actual
//! socket, so cancellation drops registrations/futures, never its descriptor.
//! The observer performs the one checked consuming close after every result.
use super::{
    Result, WebsiteFactsError,
    engine::{MAX_BODY, MAX_WIRE},
    need,
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, client::conn::http1};
use hyper_util::rt::TokioIo;
use reverie_contracts::resource_actor::EngineMetadata;
use std::{
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    pin::Pin,
    task::{Context, Poll, ready},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf, unix::AsyncFd};

struct BorrowedIo<'a> {
    socket: AsyncFd<crate::native::metadata_socket::MetadataSocket<'a>>,
    received: usize,
}
impl BorrowedIo<'_> {
    fn account(&mut self, count: usize) -> io::Result<()> {
        self.received = self.received.saturating_add(count);
        if self.received > MAX_WIRE {
            return Err(io::Error::other("ENGINE_METADATA_WIRE_BOUND"));
        }
        Ok(())
    }
}
impl AsyncRead for BorrowedIo<'_> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            let mut ready = ready!(this.socket.poll_read_ready(cx))?;
            let result = ready.try_io(|socket| {
                let mut stream = socket.get_ref().0;
                stream.read(buffer.initialize_unfilled())
            });
            match result {
                Ok(Ok(count)) => {
                    this.account(count)?;
                    buffer.advance(count);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(error)) => return Poll::Ready(Err(error)),
                Err(_) => continue,
            }
        }
    }
}
impl AsyncWrite for BorrowedIo<'_> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        loop {
            let mut ready = ready!(self.socket.poll_write_ready(cx))?;
            match ready.try_io(|socket| {
                let mut stream = socket.get_ref().0;
                stream.write(bytes)
            }) {
                Ok(result) => return Poll::Ready(result),
                Err(_) => continue,
            }
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(self.socket.get_ref().0.shutdown(std::net::Shutdown::Write))
    }
}
pub(super) async fn exchange(stream: &UnixStream, path: &str) -> Result<EngineMetadata> {
    let socket = crate::native::metadata_socket::register(stream)?;
    // Connecting did not consume writability; leave readiness for Hyper's
    // first actual write, whose WouldBlock result clears it when appropriate.
    drop(socket.writable().await?);
    if let Some(error) = stream.take_error()? {
        return Err(error.into());
    }
    let io = BorrowedIo {
        socket,
        received: 0,
    };
    let (mut sender, connection) = reverie_http::http1_builder()
        .handshake(TokioIo::new(io))
        .await
        .map_err(|_| WebsiteFactsError::Refused("ENGINE_METADATA_UNAVAILABLE"))?;
    tokio::pin!(connection);
    let response = response(&mut sender, path);
    tokio::pin!(response);
    tokio::select! {
        biased;
        result = &mut response => result,
        _closed = &mut connection => response.await,
    }
}
async fn response(
    sender: &mut http1::SendRequest<Full<Bytes>>,
    path: &str,
) -> Result<EngineMetadata> {
    let request = Request::builder()
        .method("GET")
        .uri(path)
        .header("Host", "localhost")
        .body(Full::new(Bytes::new()))
        .map_err(|_| WebsiteFactsError::Refused("FIXED_ENGINE_METADATA_ONLY"))?;
    let response = reverie_http::send_response(sender, request, true)
        .await
        .map_err(|_| WebsiteFactsError::Refused("ENGINE_METADATA_UNAVAILABLE"))?;
    need(
        response.status() == http::StatusCode::OK,
        "ENGINE_METADATA_UNAVAILABLE",
    )?;
    let mut body = response.into_body();
    use hyper::body::Body;
    need(
        body.size_hint()
            .upper()
            .is_none_or(|count| count <= MAX_BODY as u64),
        "ENGINE_METADATA_UNAVAILABLE",
    )?;
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| WebsiteFactsError::Refused("ENGINE_METADATA_UNAVAILABLE"))?;
        if let Ok(data) = frame.into_data() {
            need(
                bytes.len().saturating_add(data.len()) <= MAX_BODY,
                "ENGINE_METADATA_UNAVAILABLE",
            )?;
            bytes.extend_from_slice(&data);
        }
    }
    EngineMetadata::decode(&bytes)
        .map_err(|_| WebsiteFactsError::Refused("ENGINE_METADATA_UNAVAILABLE"))
}
