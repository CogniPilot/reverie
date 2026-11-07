//! Streaming response retains the actual upstream HTTP connection. No detached
//! driver or pump task outlives its Office request; Hyper owns all framing.
use bytes::Bytes;
use hyper::body::{Body, Frame, Incoming, SizeHint};
use std::{
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
};
type ConnectionFuture = Pin<Box<dyn Future<Output = Result<(), hyper::Error>> + Send>>;
type BodyFrame = Poll<Option<Result<Frame<Bytes>, io::Error>>>;
pub(super) struct Driver {
    future: Option<ConnectionFuture>,
    failed: bool,
}
impl Driver {
    pub(super) fn new(
        future: impl Future<Output = Result<(), hyper::Error>> + Send + 'static,
    ) -> Self {
        Self {
            future: Some(Box::pin(future)),
            failed: false,
        }
    }
    pub(super) fn poll(&mut self, cx: &mut Context<'_>) -> Poll<bool> {
        let Some(future) = self.future.as_mut() else {
            return Poll::Ready(self.failed);
        };
        match future.as_mut().poll(cx) {
            Poll::Ready(result) => {
                self.failed = result.is_err();
                self.future = None;
                Poll::Ready(self.failed)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
pub(super) enum OfficeBody {
    Fixed(Option<Bytes>),
    Stream {
        body: Incoming,
        driver: Driver,
        remaining: usize,
        done: bool,
    },
}
impl OfficeBody {
    pub(super) fn fixed(bytes: &'static [u8]) -> Self {
        Self::Fixed(Some(Bytes::from_static(bytes)))
    }
    pub(super) fn stream(body: Incoming, driver: Driver) -> Self {
        Self::Stream {
            body,
            driver,
            remaining: 32 * 1024 * 1024,
            done: false,
        }
    }
}
impl Body for OfficeBody {
    type Data = Bytes;
    type Error = io::Error;
    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        let this = self.get_mut();
        match this {
            Self::Fixed(bytes) => Poll::Ready(bytes.take().map(|bytes| Ok(Frame::data(bytes)))),
            Self::Stream {
                body,
                driver,
                remaining,
                done,
            } => stream_frame(body, driver, remaining, done, cx),
        }
    }
    fn is_end_stream(&self) -> bool {
        match self {
            Self::Fixed(bytes) => bytes.is_none(),
            Self::Stream { done, .. } => *done,
        }
    }
    fn size_hint(&self) -> SizeHint {
        match self {
            Self::Fixed(bytes) => {
                SizeHint::with_exact(bytes.as_ref().map_or(0, |bytes| bytes.len()) as u64)
            }
            Self::Stream {
                body, remaining, ..
            } => {
                let mut size = body.size_hint();
                if size.upper().is_none_or(|upper| upper > *remaining as u64) {
                    size = SizeHint::default();
                }
                size
            }
        }
    }
}
fn stream_frame(
    body: &mut Incoming,
    driver: &mut Driver,
    remaining: &mut usize,
    done: &mut bool,
    cx: &mut Context<'_>,
) -> BodyFrame {
    if *done {
        return Poll::Ready(None);
    }
    let driven = driver.poll(cx);
    match Pin::new(body).poll_frame(cx) {
        Poll::Ready(Some(Ok(frame))) => {
            let Ok(data) = frame.into_data() else {
                cx.waker().wake_by_ref();
                return Poll::Pending;
            };
            if data.len() > *remaining {
                return fail(done, "Office upstream response bound");
            }
            *remaining -= data.len();
            Poll::Ready(Some(Ok(Frame::data(data))))
        }
        Poll::Ready(None) => {
            *done = true;
            Poll::Ready(None)
        }
        Poll::Ready(Some(Err(_))) => fail(done, "Office upstream body unavailable"),
        Poll::Pending if matches!(driven, Poll::Ready(true)) => {
            fail(done, "Office upstream connection unavailable")
        }
        Poll::Pending => Poll::Pending,
    }
}
fn fail(done: &mut bool, message: &'static str) -> BodyFrame {
    *done = true;
    Poll::Ready(Some(Err(io::Error::other(message))))
}
