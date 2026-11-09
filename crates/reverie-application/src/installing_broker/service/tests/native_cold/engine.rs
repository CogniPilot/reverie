//! Test-only fixed Docker endpoint. No product runner/export, signal retry or
//! guessed PID/CID cleanup; an unknown CLI keeps its original child/pipes.
use super::*;
use nix::{
    errno::Errno,
    fcntl::{FcntlArg, OFlag, fcntl},
};
use std::{
    os::fd::OwnedFd,
    process::{Child, Command, ExitStatus, Stdio},
};

pub(super) struct Output {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
pub(super) struct Cli {
    program: PathBuf,
    root: PathBuf,
    end: Instant,
    pending: Option<Captured>,
    history: Vec<Output>,
    unknown: bool,
}
struct Captured {
    child: Option<Child>,
    out: Option<OwnedFd>,
    err: Option<OwnedFd>,
    bytes: [Vec<u8>; 2],
}
impl Cli {
    pub(super) fn new(program: PathBuf, root: PathBuf, end: Instant) -> Self {
        Self {
            program,
            root,
            end,
            pending: None,
            history: Vec::new(),
            unknown: false,
        }
    }
    pub(super) fn call(&mut self, args: &[&str]) -> Result<&Output> {
        if self.unknown || self.pending.is_some() || Instant::now() >= self.end {
            return Err("same original CLI retained/expired; no replay".into());
        }
        let mut child = Command::new(&self.program)
            .args(["--host", "unix:///var/run/docker.sock"])
            .args(args)
            .env_remove("DOCKER_HOST")
            .env_remove("DOCKER_CONTEXT")
            .env_remove("DOCKER_TLS_VERIFY")
            .env_remove("DOCKER_CERT_PATH")
            .env("DOCKER_CONFIG", self.root.join("docker-config"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let out = child.stdout.take().expect("original stdout").into();
        let err = child.stderr.take().expect("original stderr").into();
        self.pending = Some(Captured {
            child: Some(child),
            out: Some(out),
            err: Some(err),
            bytes: [Vec::new(), Vec::new()],
        });
        let body = self
            .pending
            .as_mut()
            .expect("stored before native reads")
            .read(self.end.min(Instant::now() + Duration::from_secs(20)))
            .map(|output| self.history.push(output));
        let closed = self
            .pending
            .as_mut()
            .expect("same original CLI")
            .close_known();
        match (body, closed) {
            (Ok(()), Ok(())) => (),
            (Err(a), Err(b)) => {
                self.unknown = true;
                return Err(format!("{a}; close: {b}"));
            }
            (Err(e), _) | (_, Err(e)) => {
                self.unknown = true;
                return Err(e);
            }
        };
        self.pending = None;
        let n = self.history.len();
        let output = self.history.last().expect("stored before receipt");
        let saved = tenant::write(
            &self.root.join(format!("docker-{n}.stdout")),
            &output.stdout,
        )
        .and_then(|()| {
            tenant::write(
                &self.root.join(format!("docker-{n}.stderr")),
                &output.stderr,
            )
        });
        if let Err(error) = saved {
            self.unknown = true;
            return Err(error);
        }
        Ok(output)
    }
    pub(super) fn success(&mut self, args: &[&str]) -> Result<String> {
        let out = self.call(args)?;
        if !out.success {
            return Err(format!(
                "actual Docker refusal: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        String::from_utf8(out.stdout.clone()).map_err(|e| e.to_string())
    }
    pub(super) fn known(&self) -> bool {
        !self.unknown && self.pending.is_none()
    }
}
impl Captured {
    fn read(&mut self, end: Instant) -> Result<Output> {
        for fd in [&self.out, &self.err] {
            let fd = fd.as_ref().expect("original pipe");
            let flags = fcntl(fd, FcntlArg::F_GETFL).map_err(|e| e.to_string())?;
            fcntl(
                fd,
                FcntlArg::F_SETFL(OFlag::from_bits_retain(flags) | OFlag::O_NONBLOCK),
            )
            .map_err(|e| e.to_string())?;
        }
        let mut eof = [false, false];
        loop {
            eof[0] |= drain(
                self.out.as_ref().expect("original stdout"),
                &mut self.bytes[0],
            )?;
            eof[1] |= drain(
                self.err.as_ref().expect("original stderr"),
                &mut self.bytes[1],
            )?;
            let status = self
                .child
                .as_mut()
                .expect("original CLI child")
                .try_wait()
                .map_err(|e| e.to_string())?;
            if let Some(status) = status.filter(|_| eof == [true, true]) {
                return Ok(output(
                    status,
                    std::mem::take(&mut self.bytes[0]),
                    std::mem::take(&mut self.bytes[1]),
                ));
            }
            if Instant::now() >= end {
                return Err(
                    "actual CLI outcome unknown; child/pipes retained, no signal retry".into(),
                );
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn close_known(&mut self) -> Result<()> {
        if self
            .child
            .as_mut()
            .expect("original CLI")
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Err("original CLI still live; retain entire attempt".into());
        }
        self.child = None;
        let mut errors = Vec::new();
        for fd in [self.out.take(), self.err.take()].into_iter().flatten() {
            if let Err(error) = nix::unistd::close(fd) {
                errors.push(error.to_string());
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}
fn output(status: ExitStatus, stdout: Vec<u8>, stderr: Vec<u8>) -> Output {
    Output {
        success: status.success(),
        stdout,
        stderr,
    }
}
fn drain(fd: &OwnedFd, raw: &mut Vec<u8>) -> Result<bool> {
    let mut buffer = [0; 4096];
    loop {
        match nix::unistd::read(fd, &mut buffer) {
            Ok(0) => return Ok(true),
            Ok(n) => {
                if raw.len() + n > 1_048_576 {
                    return Err("actual CLI output exceeds bounded fixture capture".into());
                }
                raw.extend_from_slice(&buffer[..n]);
            }
            Err(Errno::EAGAIN) => return Ok(false),
            Err(Errno::EINTR) => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
}
impl Drop for Captured {
    fn drop(&mut self) {
        std::mem::forget((
            self.child.take(),
            self.out.take(),
            self.err.take(),
            std::mem::take(&mut self.bytes),
        ));
    }
}
impl Drop for Cli {
    fn drop(&mut self) {
        if self.unknown || self.pending.is_some() {
            std::mem::forget((self.pending.take(), std::mem::take(&mut self.history)));
        }
    }
}
