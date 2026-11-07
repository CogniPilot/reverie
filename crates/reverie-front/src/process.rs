//! Installing-service child ownership. The service supplies its packaged Node
//! entrypoint and original argument vector; no wire request selects a command.
use command_fds::{CommandFdExt, FdMapping};
use std::{
    ffi::OsString,
    io,
    net::Shutdown,
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{ExitStatus, Stdio},
};
use tokio::{process::Child, time::Instant};

pub struct InstalledChild {
    pub node: PathBuf,
    pub entrypoint: PathBuf,
    pub arguments: Vec<OsString>,
}
pub struct FrontChild {
    child: Child,
    channel: UnixStream,
}
impl FrontChild {
    pub fn spawn(spec: InstalledChild) -> io::Result<Self> {
        let (channel, inherited) = UnixStream::pair()?;
        let mut command = tokio::process::Command::new(spec.node);
        command.arg(spec.entrypoint).args(spec.arguments);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        command.kill_on_drop(true);
        command
            .as_std_mut()
            .fd_mappings(vec![FdMapping {
                parent_fd: inherited.into(),
                child_fd: 3,
            }])
            .map_err(io::Error::other)?;
        let child = command.spawn()?;
        // command-fds owns the child endpoint until Command is dropped. Keeping
        // it alive here would hide channel EOF after the actual child exits.
        drop(command);
        Ok(Self { child, channel })
    }
    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }
    pub fn channel(&self) -> io::Result<UnixStream> {
        self.channel.try_clone()
    }
    pub fn close_channel(&self) -> io::Result<()> {
        self.channel.shutdown(Shutdown::Both)
    }
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait().await
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }
    /// The protocol owner sends shutdown before calling this. Its deadline is
    /// the absolute time to initiate KILL, not a promise of bounded kernel reap
    /// latency. Repeated signals do not extend it. Ownership remains here until
    /// wait confirms exit; an I/O error never means confirmed cleanup.
    pub async fn reap_by(&mut self, deadline: Instant) -> io::Result<ExitStatus> {
        match tokio::time::timeout_at(deadline, self.child.wait()).await {
            Ok(result) => result,
            Err(_) => {
                self.child.kill().await?;
                self.child.wait().await
            }
        }
    }
}
impl Drop for FrontChild {
    fn drop(&mut self) {
        // Fallback cleanup, never an acknowledgement of an orderly shutdown.
        // Child's kill_on_drop is the last resort; normal paths explicitly reap.
        let _ = self.channel.shutdown(Shutdown::Both);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::time::Duration;
    fn spec(name: &str) -> InstalledChild {
        InstalledChild {
            node: std::env::var_os("REVERIE_TEST_NODE")
                .expect("explicit pinned Node")
                .into(),
            entrypoint: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(name),
            arguments: Vec::new(),
        }
    }
    #[test]
    #[ignore = "requires explicit REVERIE_TEST_NODE; real fd3/grandchild qualification"]
    fn dedicated_channel_is_directly_bound_and_absent_from_ordinary_grandchildren() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(qualify_descriptor());
    }
    async fn qualify_descriptor() {
        let mut child = FrontChild::spawn(spec("fd-child.mjs")).unwrap();
        let mut channel = child.channel().unwrap();
        channel
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let challenge = format!("owned-channel-{}", std::process::id());
        channel.write_all(challenge.as_bytes()).unwrap();
        channel.shutdown(Shutdown::Write).unwrap();
        let mut response = String::new();
        channel.read_to_string(&mut response).unwrap();
        assert_eq!(response, format!("qualified:{challenge}"));
        assert!(
            child
                .reap_by(Instant::now() + Duration::from_secs(5))
                .await
                .unwrap()
                .success()
        );
    }
    #[test]
    #[ignore = "requires explicit REVERIE_TEST_NODE; real EOF and forced reap qualification"]
    fn eof_is_not_hidden_by_parent_command_and_deadline_reaps_an_unresponsive_child() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(qualify_exit());
    }
    async fn qualify_exit() {
        let mut child = FrontChild::spawn(spec("exit-child.mjs")).unwrap();
        let mut channel = child.channel().unwrap();
        channel
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        assert_eq!(channel.read(&mut [0]).unwrap(), 0);
        assert_eq!(child.wait().await.unwrap().code(), Some(17));
        let mut child = FrontChild::spawn(spec("wait-child.mjs")).unwrap();
        let deadline = Instant::now() + Duration::from_millis(100);
        let result = child.reap_by(deadline).await.unwrap();
        assert!(!result.success());
        assert!(child.id().is_none());
    }
}
