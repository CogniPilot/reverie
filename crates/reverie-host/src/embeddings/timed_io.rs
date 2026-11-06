//! Request-phase timeout accounting over the maintained hyper transport.
//! urllib sends its header block and known body before reading the response;
//! concurrent response polling must not spend that later read budget early.
use std::{
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Waker},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    time::{Sleep, sleep},
};
pub(super) trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub(super) type BoxStream = Box<dyn Stream>;
pub(super) struct TimedIo {
    inner: BoxStream,
    timeout: Duration,
    active: Arc<AtomicBool>,
    read: Option<Pin<Box<Sleep>>>,
    write: Option<Pin<Box<Sleep>>>,
    header_suffix: usize,
    header_done: bool,
    body_remaining: usize,
    read_enabled: bool,
    reader: Option<Waker>,
}
impl TimedIo {
    pub(super) fn new(inner: BoxStream, timeout: Duration, body_length: usize) -> Self {
        Self {
            inner,
            timeout,
            active: Arc::new(AtomicBool::new(true)),
            read: None,
            write: None,
            header_suffix: 0,
            header_done: false,
            body_remaining: body_length,
            read_enabled: false,
            reader: None,
        }
    }
    pub(super) fn active_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.active)
    }
    fn outgoing(&mut self, bytes: &[u8]) {
        // Observe only the delimiter and known byte count of our one generated
        // request, never parse or produce HTTP headers/framing. Hyper owns them.
        for &byte in bytes {
            if self.header_done {
                self.body_remaining = self.body_remaining.saturating_sub(1);
                continue;
            }
            const END: &[u8] = b"\r\n\r\n";
            if byte == END[self.header_suffix] {
                self.header_suffix += 1;
            } else {
                self.header_suffix = usize::from(byte == END[0]);
            }
            if self.header_suffix == END.len() {
                self.finished_header();
            }
        }
    }
    fn finished_header(&mut self) {
        self.header_done = true;
        if self.body_remaining > 0 {
            self.write = Some(Box::pin(sleep(self.timeout)));
        }
    }
    fn sent(&mut self) {
        if self.header_done && self.body_remaining == 0 {
            self.read_enabled = true;
            self.write = None;
            if let Some(reader) = self.reader.take() {
                reader.wake();
            }
        }
    }
}
fn expired(timer: &mut Option<Pin<Box<Sleep>>>, timeout: Duration, cx: &mut Context<'_>) -> bool {
    use std::future::Future;
    timer
        .get_or_insert_with(|| Box::pin(sleep(timeout)))
        .as_mut()
        .poll(cx)
        .is_ready()
}
fn timeout() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "embedding socket operation timeout",
    )
}
impl AsyncRead for TimedIo {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.active.load(Ordering::Acquire) {
            return Pin::new(&mut this.inner).poll_read(cx, buffer);
        }
        if !this.read_enabled {
            this.reader = Some(cx.waker().clone());
            return Poll::Pending;
        }
        match Pin::new(&mut this.inner).poll_read(cx, buffer) {
            Poll::Ready(result) => {
                this.read = None;
                Poll::Ready(result)
            }
            Poll::Pending if expired(&mut this.read, this.timeout, cx) => {
                Poll::Ready(Err(timeout()))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}
impl AsyncWrite for TimedIo {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if !this.active.load(Ordering::Acquire) {
            return Pin::new(&mut this.inner).poll_write(cx, buffer);
        }
        if expired(&mut this.write, this.timeout, cx) {
            return Poll::Ready(Err(timeout()));
        }
        match Pin::new(&mut this.inner).poll_write(cx, buffer) {
            Poll::Ready(Ok(count)) => {
                this.outgoing(&buffer[..count]);
                Poll::Ready(Ok(count))
            }
            other => other,
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.active.load(Ordering::Acquire) {
            return Pin::new(&mut this.inner).poll_flush(cx);
        }
        if !this.read_enabled && expired(&mut this.write, this.timeout, cx) {
            return Poll::Ready(Err(timeout()));
        }
        match Pin::new(&mut this.inner).poll_flush(cx) {
            Poll::Ready(Ok(())) => {
                this.sent();
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}
