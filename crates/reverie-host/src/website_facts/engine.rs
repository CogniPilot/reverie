use super::*;
use nix::sys::socket::{AddressFamily, SockFlag, SockType, UnixAddr, connect, socket};
use std::{
    fs,
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt},
            net::UnixStream,
        },
    },
    time::{Duration, Instant},
};
const SECONDS: Duration = Duration::from_secs(2);
pub(super) const MAX_BODY: usize = reverie_contracts::resource_actor::MAX_ENGINE_BODY;
pub(super) const MAX_WIRE: usize = MAX_BODY + 65536;
fn identity(path: &std::path::Path) -> Result<[u64; 4]> {
    let info = fs::symlink_metadata(path)?;
    need(info.file_type().is_socket(), "ENGINE_SOCKET_REQUIRED")?;
    Ok([
        info.dev(),
        info.ino(),
        u64::from(info.uid()),
        u64::from(info.gid()),
    ])
}
impl WebsiteMetadataObserver {
    pub fn assert_finalized(&self) -> Result<()> {
        need(!self.close_uncertain, "ENGINE_METADATA_CLOSE_UNCONFIRMED")
    }
    pub fn new(selected: &EngineSelection) -> Result<Self> {
        let socket = native::python_path(selected.socket.codepoints())?;
        let identity = selected
            .identity
            .iter()
            .map(|value| value.to_u64())
            .collect::<Option<Vec<_>>>()
            .ok_or(WebsiteFactsError::Refused("ENGINE_SOCKET_IDENTITY"))?
            .try_into()
            .expect("four selected identity fields");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        Ok(Self {
            socket,
            identity,
            engine_id: selected.id.clone(),
            runtime,
            close_uncertain: false,
        })
    }
    fn guard_socket(&self) -> Result<()> {
        need(!self.close_uncertain, "ENGINE_METADATA_CLOSE_UNCONFIRMED")?;
        need(
            identity(&self.socket)? == self.identity,
            "ENGINE_SOCKET_REBOUND",
        )
    }
    /// One absolute two-second operation, shortened by the actual caller's
    /// deadline. Progress never restarts it. Every socket is closed once, even
    /// on connect, parser, response, wire-bound or timeout failures.
    pub fn observe(&mut self, route: WebsiteMetadataRoute, end: Instant) -> Result<EngineMetadata> {
        let end = end.min(Instant::now() + SECONDS);
        self.guard_socket()?;
        need(Instant::now() < end, "ENGINE_METADATA_DEADLINE")?;
        // This synchronous broker observer never nests block_on in a Tokio
        // task. A future async service can own its own borrowed transport.
        need(
            tokio::runtime::Handle::try_current().is_err(),
            "ENGINE_METADATA_RUNTIME",
        )?;
        let address = UnixAddr::new(&self.socket).map_err(io::Error::from)?;
        let descriptor = socket(
            AddressFamily::Unix,
            SockType::Stream,
            SockFlag::SOCK_CLOEXEC | SockFlag::SOCK_NONBLOCK,
            None,
        )
        .map_err(io::Error::from)?;
        let connected = connect(descriptor.as_raw_fd(), &address);
        let stream = UnixStream::from(descriptor);
        let body = match connected {
            Ok(()) | Err(nix::errno::Errno::EINPROGRESS) => self.runtime.block_on(async {
                tokio::time::timeout_at(
                    tokio::time::Instant::from_std(end),
                    transport::exchange(&stream, &route.path()),
                )
                .await
                .map_err(|_| WebsiteFactsError::Refused("ENGINE_METADATA_DEADLINE"))?
            }),
            Err(error) => Err(io::Error::from(error).into()),
        }
        .and_then(|value| {
            self.guard_socket()?;
            need(Instant::now() < end, "ENGINE_METADATA_DEADLINE")?;
            Ok(value)
        });
        let closed = native::close(std::fs::File::from(std::os::fd::OwnedFd::from(stream)));
        if closed.is_err() {
            self.close_uncertain = true;
        }
        match (body, closed) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(_)) => Err(WebsiteFactsError::Cleanup),
            (Err(primary), Err(_)) => Err(WebsiteFactsError::Finalization {
                primary: Box::new(primary),
                secondary: Box::new(WebsiteFactsError::Cleanup),
            }),
        }
    }
    /// Same-kernel observation only. No peer or owner authority is produced.
    pub fn guard_same_kernel(&mut self, end: Instant) -> Result<()> {
        let info = self.observe(WebsiteMetadataRoute::Info, end)?;
        let release = native::kernel_release()
            .map_err(|_| WebsiteFactsError::Refused("SAME_KERNEL_ENGINE_REQUIRED"))?;
        info.require_same_kernel(&self.engine_id, &release)
            .map_err(|_| WebsiteFactsError::Refused("SAME_KERNEL_ENGINE_REQUIRED"))
    }
}
