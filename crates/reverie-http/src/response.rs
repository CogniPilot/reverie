//! Shared HTTP/1 response-head handling over the maintained hyper parser.
use bytes::Bytes;
use http::Request;
use http_body_util::Full;
use hyper::{body::Incoming, client::conn::http1};
use std::{
    fmt,
    future::{Future, poll_fn},
};

#[derive(Debug)]
pub enum ResponseError {
    Transport(hyper::Error),
    Informational(u16),
}
impl fmt::Display for ResponseError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(error) => write!(out, "{error}"),
            Self::Informational(status) => {
                write!(out, "unexpected HTTP informational status {status}")
            }
        }
    }
}
impl std::error::Error for ResponseError {}

/// Retain the existing aggregate header allowance and multiline support.
/// This does not reproduce every Python line/chunk/trailer parsing rule;
/// see the crate README. Callers own body bounds, status and auth policy.
pub fn http1_builder() -> http1::Builder {
    let mut builder = http1::Builder::new();
    builder
        .max_headers(99)
        .max_buf_size(100 * 65536 + 2)
        .max_header_size(100 * 65536 + 2)
        .allow_obsolete_multiline_headers_in_responses(true);
    builder
}

/// Python skips 100 Continue, but does not silently skip every other 1xx head
/// to accept a later final response. Hyper still owns all HTTP framing.
pub async fn send_response(
    sender: &mut http1::SendRequest<Full<Bytes>>,
    mut request: Request<Full<Bytes>>,
    allow_continue: bool,
) -> Result<hyper::Response<Incoming>, ResponseError> {
    let (notify, mut notified) = tokio::sync::mpsc::channel(1);
    hyper::ext::on_informational(&mut request, move |response| {
        let status = response.status().as_u16();
        if !allow_continue || status != 100 {
            let _ = notify.try_send(status);
        }
    });
    let response = sender.send_request(request);
    let mut response = std::pin::pin!(response);
    poll_fn(|cx| {
        if let std::task::Poll::Ready(Some(status)) = notified.poll_recv(cx) {
            return std::task::Poll::Ready(Err(ResponseError::Informational(status)));
        }
        let result = response.as_mut().poll(cx);
        if let std::task::Poll::Ready(Some(status)) = notified.poll_recv(cx) {
            return std::task::Poll::Ready(Err(ResponseError::Informational(status)));
        }
        result.map(|result| result.map_err(ResponseError::Transport))
    })
    .await
}
