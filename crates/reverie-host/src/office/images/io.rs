//! Purpose-local nonblocking I/O borrows the actor's checked-close stream.
//! Hyper borrows the live std stream; no reactor registration can consume its
//! FD on failure, and its actual owner checked-closes it after driver drop.
//! Connect has the original clipped five-second timeout; nonblocking reads and
//! writes retain that idle budget with five-millisecond readiness polling.
//! Kernel scheduling/filesystem latency is not a hard wall-clock bound.
use super::{OfficeImageError, Result};
use crate::worker_runtime::WorkerRuntime;
use nix::sys::{
    socket::{self, AddressFamily, SockFlag, SockType, UnixAddr, sockopt},
    time::{TimeVal, TimeValLike},
};
use std::{
    future::Future,
    io::{self, Read, Write},
    os::{fd::AsRawFd, unix::net::UnixStream},
    path::Path,
    pin::Pin,
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
pub(super) fn left(runtime: &WorkerRuntime, end: Instant) -> io::Result<Duration> {
    let end = runtime.stop_deadline().map_or(end, |stop| stop.min(end));
    let remaining = end.saturating_duration_since(Instant::now());
    if remaining.is_zero() || runtime.cancellation().is_cancelled() {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "image operation deadline",
        ))
    } else {
        Ok(remaining.min(Duration::from_secs(5)))
    }
}
pub(super) fn connect(path: &Path, runtime: &WorkerRuntime, end: Instant) -> Result<UnixStream> {
    let fd = socket::socket(
        AddressFamily::Unix,
        SockType::Stream,
        SockFlag::SOCK_CLOEXEC,
        None,
    )
    .map_err(|e| OfficeImageError::Io(io::Error::from_raw_os_error(e as i32)))?;
    let result = (|| {
        let remaining = left(runtime, end)?;
        let timeout =
            TimeVal::microseconds(i64::try_from(remaining.as_micros().max(1)).unwrap_or(i64::MAX));
        socket::setsockopt(&fd, sockopt::SendTimeout, &timeout).map_err(io::Error::from)?;
        socket::setsockopt(&fd, sockopt::ReceiveTimeout, &timeout).map_err(io::Error::from)?;
        let address = UnixAddr::new(path).map_err(io::Error::from)?;
        socket::connect(fd.as_raw_fd(), &address).map_err(io::Error::from)?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            let stream = UnixStream::from(fd);
            match stream.set_nonblocking(true) {
                Ok(()) => Ok(stream),
                Err(error) => super::finalized(
                    Err(OfficeImageError::Io(error)),
                    crate::native::owned_process::close(stream.into())
                        .map_err(OfficeImageError::Close),
                ),
            }
        }
        Err(error) => super::finalized(
            Err(OfficeImageError::Io(error)),
            crate::native::owned_process::close(fd).map_err(OfficeImageError::Close),
        ),
    }
}
pub(super) struct ImageIo<'a> {
    pub stream: &'a mut UnixStream,
    pub runtime: &'a WorkerRuntime,
    pub end: Instant,
    pub headers: std::rc::Rc<std::cell::RefCell<super::raw_headers::Headers>>,
    pub read: Delay,
    pub write: Delay,
}
#[derive(Default)]
pub(super) struct Delay {
    idle: Option<Instant>,
    retry: Option<Pin<Box<tokio::time::Sleep>>>,
}
impl Delay {
    fn wait(
        &mut self,
        runtime: &WorkerRuntime,
        end: Instant,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        let now = Instant::now();
        let idle = *self.idle.get_or_insert(now + Duration::from_secs(5));
        if let Err(error) = left(runtime, end.min(idle)) {
            return Poll::Ready(Err(error));
        }
        if self
            .retry
            .as_mut()
            .is_some_and(|timer| timer.as_mut().poll(cx).is_pending())
        {
            return Poll::Pending;
        }
        let pause = end.min(idle).min(now + Duration::from_millis(5));
        let mut retry = Box::pin(tokio::time::sleep_until(pause.into()));
        let _ = retry.as_mut().poll(cx);
        self.retry = Some(retry);
        Poll::Pending
    }
}
impl AsyncRead for ImageIo<'_> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let result: io::Result<()> = (|| {
            left(this.runtime, this.end)?;
            let output = buffer.initialize_unfilled();
            let count = this.stream.read(output)?;
            this.headers.borrow_mut().observe(&output[..count])?;
            buffer.advance(count);
            Ok(())
        })();
        match result {
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                this.read.wait(this.runtime, this.end, cx)
            }
            result => {
                this.read = Delay::default();
                Poll::Ready(result)
            }
        }
    }
}
impl AsyncWrite for ImageIo<'_> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = left(this.runtime, this.end).and_then(|_| this.stream.write(buffer));
        match result {
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => this
                .write
                .wait(this.runtime, this.end, cx)
                .map(|result| result.map(|()| 0)),
            result => {
                this.write = Delay::default();
                Poll::Ready(result)
            }
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
