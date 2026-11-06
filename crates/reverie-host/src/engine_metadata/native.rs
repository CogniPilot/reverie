//! Shared narrow owned-process syscalls; metadata query policy stays here.
pub(super) use crate::native::owned_process::{
    Handshake, PreparationError, ReceiveError, close, executable, kill, nonblocking, poll, read,
    reap,
};
