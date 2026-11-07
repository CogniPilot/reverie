//! Borrowed reactor registration. The sole owning UnixStream stays outside
//! every cancellable HTTP future and is explicitly checked-closed afterwards.
#![allow(unsafe_code)]
use std::{
    io,
    os::{
        fd::{AsRawFd, RawFd},
        unix::net::UnixStream,
    },
};
use tokio::io::unix::AsyncFd;

pub(crate) struct MetadataSocket<'a>(pub(crate) &'a UnixStream);
impl AsRawFd for MetadataSocket<'_> {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_raw_fd()
    }
}
pub(crate) fn register(stream: &UnixStream) -> io::Result<AsyncFd<MetadataSocket<'_>>> {
    // SAFETY: UnixStream owns this exact open descriptor and cannot be moved
    // or closed while the returned registration borrows it. MetadataSocket
    // exposes no mutable/owning access and always returns that same fd. The
    // reactor registration and every borrowing HTTP future are dropped before
    // the caller consumes the original stream in the one checked native close.
    unsafe { AsyncFd::register(MetadataSocket(stream)) }.map_err(io::Error::from)
}
