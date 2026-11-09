use super::{OfficeImageError, Result, io::ImageIo, need, raw_headers::Headers};
use crate::worker_runtime::WorkerRuntime;
use bytes::Bytes;
use http::{Request, StatusCode};
use http_body_util::Full;
use hyper::body::{Body, Incoming};
use hyper_util::rt::TokioIo;
use std::{
    cell::RefCell,
    future::{Future, poll_fn},
    os::unix::net::UnixStream,
    pin::Pin,
    rc::Rc,
    task::Poll,
    time::Instant,
};

pub(super) async fn read(
    stream: &mut UnixStream,
    runtime: &WorkerRuntime,
    endpoint: &str,
    maximum: usize,
    end: Instant,
) -> Result<(Vec<u8>, Vec<Vec<u8>>)> {
    let headers = Rc::new(RefCell::new(Headers::default()));
    let io = ImageIo {
        stream,
        runtime,
        end,
        headers: headers.clone(),
        read: super::io::Delay::default(),
        write: super::io::Delay::default(),
    };
    let (mut sender, connection) = reverie_http::http1_builder()
        .handshake(TokioIo::new(io))
        .await
        .map_err(|_| OfficeImageError::Refused("office_unavailable"))?;
    let mut connection = std::pin::pin!(connection);
    let mut finished = false;
    let request = Request::builder()
        .method("GET")
        .uri(endpoint)
        .header("host", "localhost")
        .header("accept-encoding", "identity")
        .header("connection", "close")
        .body(Full::<Bytes>::new(Bytes::new()))
        .expect("fixed image request");
    let response = {
        let response = reverie_http::send_response(&mut sender, request, true);
        let mut response = std::pin::pin!(response);
        poll_fn(|cx| {
            if let Poll::Ready(result) = response.as_mut().poll(cx) {
                return Poll::Ready(result);
            }
            let driven = if finished {
                Poll::Ready(Ok(()))
            } else {
                connection.as_mut().poll(cx)
            };
            finished |= driven.is_ready();
            match response.as_mut().poll(cx) {
                Poll::Pending if matches!(driven, Poll::Ready(Err(_))) => {
                    Poll::Ready(Err(reverie_http::ResponseError::Informational(0)))
                }
                result => result,
            }
        })
        .await
        .map_err(|_| OfficeImageError::Refused("office_unavailable"))?
    };
    need(
        response.status() == StatusCode::OK,
        "access_or_body_refused",
    )?;
    let expected = headers.borrow().expected(maximum)?;
    let mut incoming = response.into_body();
    let mut bytes = Vec::with_capacity(expected);
    while let Some(data) = frame(&mut incoming, connection.as_mut(), &mut finished).await? {
        need(bytes.len() + data.len() <= maximum, "body_limit")?;
        bytes.extend(data);
    }
    need(bytes.len() == expected, "body_or_binding_changed")?;
    let content_types = headers.borrow().content_types();
    Ok((bytes, content_types))
}
async fn frame<T>(
    incoming: &mut Incoming,
    mut connection: Pin<&mut T>,
    finished: &mut bool,
) -> Result<Option<Bytes>>
where
    T: Future<Output = std::result::Result<(), hyper::Error>>,
{
    loop {
        let frame = poll_fn(|cx| {
            let driven = if *finished {
                Poll::Ready(Ok(()))
            } else {
                connection.as_mut().poll(cx)
            };
            *finished |= driven.is_ready();
            match Pin::new(&mut *incoming).poll_frame(cx) {
                Poll::Pending if matches!(driven, Poll::Ready(Err(_))) => {
                    Poll::Ready(Some(Err(std::io::Error::other("image connection failed"))))
                }
                result => {
                    result.map(|result| result.map(|frame| frame.map_err(std::io::Error::other)))
                }
            }
        })
        .await
        .transpose()
        .map_err(OfficeImageError::Io)?;
        match frame {
            Some(frame) => {
                if let Ok(data) = frame.into_data() {
                    return Ok(Some(data));
                }
            }
            None => return Ok(None),
        }
    }
}
