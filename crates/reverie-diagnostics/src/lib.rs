//! Small best-effort diagnostic transport, independent of runtime policy.
//! Delivery never acknowledges cleanup, an operation outcome or authority.
use std::io;
#[cfg(target_os = "linux")]
mod linux;

/// At most this many bytes are offered in one diagnostic attempt.
pub const MAX_BYTES: usize = 1024;

#[derive(Clone, Copy)]
enum StandardStream {
    Output,
    Error,
}

/// Emit at most MAX_BYTES on stderr, once, without a stdio lock or retry.
/// Pipe/socket backpressure cannot delay a runtime's cleanup. The caller must
/// perform cleanup first and retain its original error regardless of delivery.
/// This does not promise bounds on kernel/filesystem latency. File offset and
/// append behavior are inherited; original descriptor flags are never changed.
pub fn stderr(message: &[u8]) -> io::Result<()> {
    emit(message, StandardStream::Error)
}

/// The fixed inherited stdout companion, with the same one-attempt byte bound
/// and best-effort delivery contract as stderr. Never a caller-selected fd.
pub fn stdout(message: &[u8]) -> io::Result<()> {
    emit(message, StandardStream::Output)
}

/// The fixed live terminal-resize report. Unlike terminal-error diagnostics,
/// the caller still owns an ongoing viewer and must retain it on any error.
/// Refuse oversize rather than acknowledge a truncated report. The same fd2
/// adapter attempts the entire bounded report once without changing OFD flags.
pub fn terminal_resize_report(message: &[u8]) -> io::Result<()> {
    if message.len() > MAX_BYTES {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    emit(message, StandardStream::Error)
}

fn emit(message: &[u8], stream: StandardStream) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux::emit(stream, &message[..message.len().min(MAX_BYTES)])
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (message, stream);
        Err(io::ErrorKind::Unsupported.into())
    }
}
