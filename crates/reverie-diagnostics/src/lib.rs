//! Small best-effort diagnostic transport, independent of runtime policy.
//! Delivery never acknowledges cleanup, an operation outcome or authority.
use std::io;
#[cfg(target_os = "linux")]
mod linux;

/// At most this many bytes are offered in one diagnostic attempt.
pub const MAX_BYTES: usize = 1024;

/// Emit at most MAX_BYTES on stderr, once, without a stdio lock or retry.
/// Pipe/socket backpressure cannot delay a runtime's cleanup. The caller must
/// perform cleanup first and retain its original error regardless of delivery.
/// This does not promise bounds on kernel/filesystem latency. File offset and
/// append behavior are inherited; original descriptor flags are never changed.
pub fn stderr(message: &[u8]) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux::stderr(&message[..message.len().min(MAX_BYTES)])
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = message;
        Err(io::ErrorKind::Unsupported.into())
    }
}
