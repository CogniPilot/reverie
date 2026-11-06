//! Rust-owned listener/process transport. No HTTP parsing or authentication is
//! moved here in phase 2a. Selection awaits the complete adapter qualification.
pub mod budget;
#[cfg(unix)]
pub mod channel;
#[cfg(unix)]
mod network;
pub mod outbox;
#[cfg(unix)]
pub mod process;
#[cfg(unix)]
pub mod session;
#[cfg(unix)]
pub mod supervisor;
#[cfg(unix)]
pub mod tls;

pub const MAX_CONNECTIONS: usize = 4096;
pub const DIRECTION_BYTES: usize = 32 << 20;
pub const CONTROL_BYTES: usize = 1 << 20;
