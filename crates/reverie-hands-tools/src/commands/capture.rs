use crate::protocol::Reply;
use std::{io, os::unix::process::ExitStatusExt, process::ExitStatus, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Child,
    time::{Instant, sleep_until},
};

struct Stream<R> {
    source: Option<R>,
    head: Vec<u8>,
    tail: Vec<u8>,
    half: usize,
    total: usize,
}

impl<R: AsyncRead + Unpin> Stream<R> {
    fn new(source: Option<R>, half: usize) -> Self {
        Self {
            source,
            head: Vec::new(),
            tail: Vec::new(),
            half,
            total: 0,
        }
    }

    async fn read(&mut self) -> io::Result<()> {
        let mut data = [0; 8192];
        let bytes = self
            .source
            .as_mut()
            .expect("open stream")
            .read(&mut data)
            .await?;
        if bytes == 0 {
            self.source = None;
            return Ok(());
        }
        let keep = bytes.min(self.half - self.head.len());
        self.head.extend_from_slice(&data[..keep]);
        let rest = &data[keep..bytes];
        if rest.len() >= self.half {
            self.tail.clear();
            self.tail.extend_from_slice(&rest[rest.len() - self.half..]);
        } else {
            let old = (self.tail.len() + rest.len()).saturating_sub(self.half);
            self.tail.drain(..old);
            self.tail.extend_from_slice(rest);
        }
        self.total += bytes;
        Ok(())
    }

    fn finish(self, name: &str) -> (String, bool) {
        let lost = self.total - self.head.len() - self.tail.len();
        let start = String::from_utf8_lossy(&self.head);
        let end = String::from_utf8_lossy(&self.tail);
        let mut out = format!("--- {name} ({} bytes) ---\n{start}", self.total);
        if lost > 0 {
            out.push_str(&format!(
                "\n[... {lost} of {} bytes omitted ...]\n",
                self.total
            ));
        }
        out.push_str(&end);
        if self.source.is_some() {
            out.push_str("\n[output pipe remained open at the deadline]");
        }
        (out, lost > 0 || self.source.is_some())
    }
}

pub(super) struct Observation {
    pub(super) exit: i32,
    timed_out: bool,
    out: (String, bool),
    err: (String, bool),
}

impl Observation {
    pub(super) fn reply(self, seconds: u64) -> Reply {
        let status = if self.timed_out {
            "timeout".into()
        } else {
            self.exit.to_string()
        };
        let value = if self.timed_out {
            Err(format!(
                "timed out after {seconds} s; the command was killed"
            ))
        } else {
            Ok(self.exit)
        };
        Reply::command(
            format!("exit_code: {status}\n{}\n{}", self.out.0, self.err.0),
            self.out.1 || self.err.1,
            value,
        )
    }
}

pub(super) async fn observe(
    mut child: Child,
    timeout: Duration,
    limit: usize,
) -> io::Result<Observation> {
    let half = (10_000.min(limit / 2 - 100)) / 2;
    let mut out = Stream::new(child.stdout.take(), half);
    let mut err = Stream::new(child.stderr.take(), half);
    let mut status = None;
    let mut deadline = Instant::now() + timeout;
    // Keep the trusted controller's process group. Its existing watchdog
    // terminates the runner and every command descendant on cancellation.
    while status.is_none() || out.source.is_some() || err.source.is_some() {
        tokio::select! {
            result = child.wait(), if status.is_none() => {
                status = Some(result?);
                deadline = deadline.min(Instant::now() + Duration::from_millis(250));
            }
            result = out.read(), if out.source.is_some() => result?,
            result = err.read(), if err.source.is_some() => result?,
            () = sleep_until(deadline) => break,
        }
    }
    let status = status.or(child.try_wait()?);
    let timed_out = status.is_none();
    let status = match status {
        Some(value) => value,
        None => {
            child.start_kill()?;
            child.wait().await?
        }
    };
    Ok(Observation {
        exit: exit_number(status),
        timed_out,
        out: out.finish("stdout"),
        err: err.finish("stderr"),
    })
}

fn exit_number(status: ExitStatus) -> i32 {
    status
        .code()
        .unwrap_or_else(|| -status.signal().unwrap_or(1))
}
