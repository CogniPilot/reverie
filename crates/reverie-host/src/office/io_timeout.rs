//! Idle socket bounds around Hyper's parser; no HTTP framing is implemented here.
use std::{
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    time::{Sleep, sleep},
};
pub(super) struct IdleIo<T> {
    inner: T,
    read: Option<Pin<Box<Sleep>>>,
    write: Option<Pin<Box<Sleep>>>,
    timeout: Duration,
}
impl<T> IdleIo<T> {
    pub(super) fn new(inner: T, timeout: Duration) -> Self {
        Self {
            inner,
            read: None,
            write: None,
            timeout,
        }
    }
}
fn elapsed(timer: &mut Option<Pin<Box<Sleep>>>, timeout: Duration, cx: &mut Context<'_>) -> bool {
    timer
        .get_or_insert_with(|| Box::pin(sleep(timeout)))
        .as_mut()
        .poll(cx)
        .is_ready()
}
fn expired<T>() -> Poll<io::Result<T>> {
    Poll::Ready(Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "Office socket deadline",
    )))
}
impl<T: AsyncRead + Unpin> AsyncRead for IdleIo<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if elapsed(&mut this.read, this.timeout, cx) {
            return expired();
        }
        match Pin::new(&mut this.inner).poll_read(cx, buffer) {
            Poll::Ready(result) => {
                this.read = None;
                Poll::Ready(result)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
impl<T: AsyncWrite + Unpin> AsyncWrite for IdleIo<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if elapsed(&mut this.write, this.timeout, cx) {
            return expired();
        }
        match Pin::new(&mut this.inner).poll_write(cx, buffer) {
            Poll::Ready(result) => {
                this.write = None;
                Poll::Ready(result)
            }
            Poll::Pending => Poll::Pending,
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if elapsed(&mut this.write, this.timeout, cx) {
            return expired();
        }
        match Pin::new(&mut this.inner).poll_flush(cx) {
            Poll::Ready(result) => {
                this.write = None;
                Poll::Ready(result)
            }
            Poll::Pending => Poll::Pending,
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}
