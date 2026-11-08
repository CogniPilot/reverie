//! Shared controlled-test capture and fixed Docker endpoint. This cfg(test)
//! module is never a product engine/command callback interface.
use crate::native::owned_process as process;
use std::{
    io,
    os::fd::OwnedFd,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

pub(super) fn command() -> Command {
    let mut command = Command::new("docker");
    command
        .args(["--host", "unix:///var/run/docker.sock"])
        .env_remove("DOCKER_HOST")
        .env_remove("DOCKER_CONTEXT");
    command
}
pub(super) fn run(args: &[&str]) -> std::result::Result<String, String> {
    capture(command().args(args))
}
/// Private controlled-test command capture. Product engine authority never
/// reaches this module; each owning test constructs its fixed purpose argv.
pub(super) fn capture(command: &mut Command) -> std::result::Result<String, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout: OwnedFd = child.stdout.take().expect("owned stdout").into();
    let stderr: OwnedFd = child.stderr.take().expect("owned stderr").into();
    let mut owner = Captured {
        child: Some(child),
        stdout: Some(stdout),
        stderr: Some(stderr),
        kill_attempted: false,
    };
    let result = owner.read();
    let closed = owner.close();
    match (result, closed) {
        (Ok(raw), Ok(())) => Ok(raw),
        (Err(error), _) | (_, Err(error)) => Err(error),
    }
}
struct Captured {
    child: Option<Child>,
    stdout: Option<OwnedFd>,
    stderr: Option<OwnedFd>,
    kill_attempted: bool,
}
impl Captured {
    fn read(&mut self) -> std::result::Result<String, String> {
        for fd in [&self.stdout, &self.stderr] {
            process::nonblocking(fd.as_ref().unwrap()).map_err(|e| e.to_string())?;
        }
        let end = Instant::now() + Duration::from_secs(30);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut eof = [false, false];
        loop {
            eof[0] |= drain(self.stdout.as_ref().unwrap(), &mut out)?;
            eof[1] |= drain(self.stderr.as_ref().unwrap(), &mut err)?;
            let status = self
                .child
                .as_mut()
                .unwrap()
                .try_wait()
                .map_err(|e| e.to_string())?;
            if let Some(status) = status.filter(|_| eof == [true, true]) {
                return outcome(status, out, err);
            }
            if Instant::now() >= end {
                return Err("owned Docker result unknown after30s".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn close(&mut self) -> std::result::Result<(), String> {
        if let Some(child) = self.child.as_mut()
            && child.try_wait().map_err(|e| e.to_string())?.is_none()
        {
            if self.kill_attempted {
                return Err("owned CLI kill outcome retained; no repeat".into());
            }
            self.kill_attempted = true;
            child.kill().map_err(|e| e.to_string())?;
            child.wait().map_err(|e| e.to_string())?;
        }
        self.child = None;
        let mut failure = None;
        for fd in [self.stdout.take(), self.stderr.take()]
            .into_iter()
            .flatten()
        {
            if let Err(error) = process::close(fd) {
                failure = Some(error.to_string());
            }
        }
        failure.map_or(Ok(()), Err)
    }
}
fn outcome(
    status: std::process::ExitStatus,
    out: Vec<u8>,
    err: Vec<u8>,
) -> std::result::Result<String, String> {
    if status.success() {
        String::from_utf8(out).map_err(|e| e.to_string())
    } else {
        Err(format!(
            "owned subprocess refused: {}",
            String::from_utf8_lossy(&err)
        ))
    }
}
impl Drop for Captured {
    fn drop(&mut self) {
        if self.close().is_err() {
            // Exact controlled-test uncertainty, never a successful fixture
            // cleanup receipt. Preserve the actual process/pipe owners.
            std::mem::forget((self.child.take(), self.stdout.take(), self.stderr.take()));
        }
    }
}
pub(super) fn drain(fd: &OwnedFd, raw: &mut Vec<u8>) -> std::result::Result<bool, String> {
    let mut buffer = [0; 4096];
    loop {
        match process::read(fd, &mut buffer) {
            Ok(0) => return Ok(true),
            Ok(count) => {
                if raw.len().saturating_add(count) > 1_048_576 {
                    return Err("owned output bound".into());
                }
                raw.extend_from_slice(&buffer[..count]);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) => return Err(error.to_string()),
        }
    }
}
