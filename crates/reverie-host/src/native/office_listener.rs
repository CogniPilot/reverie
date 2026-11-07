//! Borrow only the actual Office listener during reactor registration. No
//! arbitrary fd, mutable backing value, or general IO authority is exposed.
#![allow(unsafe_code)]
use std::{
    io,
    os::{
        fd::{AsFd, BorrowedFd},
        unix::net::{UnixListener, UnixStream},
    },
};
use tokio::io::unix::AsyncFd;
pub(crate) struct OfficeListenerReady<'a> {
    listener: &'a UnixListener,
    readiness: AsyncFd<BorrowedFd<'a>>,
}
impl<'a> OfficeListenerReady<'a> {
    pub(crate) fn register(listener: &'a UnixListener) -> io::Result<Self> {
        // SAFETY: BorrowedFd comes directly from this live owned listener.
        // Its Rust borrow keeps that descriptor open, stable and unchanged
        // through readiness drop. The backing value is private and never
        // replaced/forgotten; registration runs inside this Office runtime.
        let readiness =
            unsafe { AsyncFd::register(listener.as_fd()) }.map_err(|error| error.into_parts().1)?;
        Ok(Self {
            listener,
            readiness,
        })
    }
    pub(crate) async fn accept(&self) -> io::Result<UnixStream> {
        loop {
            let mut ready = self.readiness.readable().await?;
            if let Ok(result) = ready.try_io(|_| self.listener.accept()) {
                return result.map(|(stream, _)| stream);
            }
        }
    }
}
