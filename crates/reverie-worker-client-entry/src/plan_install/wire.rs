use super::{Failure, Result, join, need};
use nix::{
    fcntl::{FcntlArg, OFlag, fcntl},
    poll::{PollFd, PollFlags, PollTimeout, poll},
    unistd::{close, dup, read as read_fd},
};
use std::{
    os::fd::AsFd,
    time::{Duration, Instant},
};
pub(super) fn read() -> Result<Vec<u8>> {
    let input = dup(std::io::stdin()).map_err(|e| Failure::new("stdin-duplicate", e))?;
    let result = (|| {
        let flags = fcntl(&input, FcntlArg::F_GETFL).map_err(|e| Failure::new("stdin-flags", e))?;
        fcntl(
            &input,
            FcntlArg::F_SETFL(OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK),
        )
        .map_err(|e| Failure::new("stdin-nonblocking", e))?;
        collect(&input, Instant::now() + Duration::from_secs(3))
    })();
    let closed = close(input).map_err(|e| Failure::new("stdin-close", e));
    join(result, closed)
}
fn collect(input: &impl AsFd, end: Instant) -> Result<Vec<u8>> {
    let mut bytes = vec![];
    loop {
        let remaining = end.saturating_duration_since(Instant::now());
        need(!remaining.is_zero(), "stdin-timeout")?;
        let timeout =
            PollTimeout::try_from(remaining).map_err(|e| Failure::new("stdin-timeout", e))?;
        let mut descriptors = [PollFd::new(input.as_fd(), PollFlags::POLLIN)];
        need(
            poll(&mut descriptors, timeout).map_err(|e| Failure::new("stdin-poll", e))? > 0,
            "stdin-timeout",
        )?;
        let mut chunk = [0_u8; 8192];
        let count = match read_fd(input, &mut chunk) {
            Ok(count) => count,
            Err(nix::errno::Errno::EAGAIN) => continue,
            Err(e) => return Err(Failure::new("stdin-read", e)),
        };
        if count == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&chunk[..count]);
        need(bytes.len() <= super::input::WIRE_LIMIT, "stdin-bound")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::unistd::{pipe2, write};
    #[test]
    fn actual_pipe_closes_at_eof_and_empty_live_input_has_a_deadline() {
        let (input, output) = pipe2(OFlag::O_NONBLOCK | OFlag::O_CLOEXEC).unwrap();
        write(&output, b"{\"synthetic\":true}\n").unwrap();
        close(output).unwrap();
        let result = collect(&input, Instant::now() + Duration::from_secs(1));
        close(input).unwrap();
        assert_eq!(result.unwrap(), b"{\"synthetic\":true}\n");
        let (input, output) = pipe2(OFlag::O_NONBLOCK | OFlag::O_CLOEXEC).unwrap();
        assert!(collect(&input, Instant::now() + Duration::from_millis(20)).is_err());
        close(input).unwrap();
        close(output).unwrap();
    }
}
