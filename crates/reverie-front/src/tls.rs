//! Installed TLS material and bounded encrypted transport. No path is supplied
//! by a frame or HTTP request; the installing service owns these two paths.
use crate::{
    budget::{ByteLease, BytePool},
    network::Transport,
};
use rustls::{
    ServerConfig,
    pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read},
    num::NonZeroU32,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
};
use tokio_rustls::{TlsAcceptor, server::TlsStream};
pub(crate) mod pending;
pub(crate) mod scratch;
use scratch::{ScratchWait, SharedScratch};
#[cfg(test)]
mod tests;

pub(crate) const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);
const MATERIAL_BYTES: u64 = 64 << 10;
// Retained wire/record buffers and pending bounded control output, independently
// of application frame leases. Transient message decoding has separate scratch.
pub(crate) const TLS_RESERVE: u32 = 256 << 10;
// Keep the full parser/state allowance throughout an initial handshake.
pub(crate) const HANDSHAKE_RESERVE: u32 = scratch::SCRATCH_BYTES;
const HANDSHAKE_INPUT: usize = 256 << 10;
const CONTROL_INPUT: usize = 1 << 20;
const APPLICATION_OUTPUT: usize = 64 << 10;

#[derive(Clone, Debug)]
pub struct TlsFiles {
    certificate: PathBuf,
    private_key: PathBuf,
    #[cfg(test)]
    fail_material_close: bool,
}
impl TlsFiles {
    pub fn new(certificate: PathBuf, private_key: PathBuf) -> io::Result<Self> {
        if !certificate.is_absolute() || !private_key.is_absolute() {
            return Err(invalid("TLS material paths must be absolute"));
        }
        Ok(Self {
            certificate,
            private_key,
            #[cfg(test)]
            fail_material_close: false,
        })
    }
    pub(crate) async fn load(&self) -> io::Result<Arc<ServerConfig>> {
        let files = self.clone();
        tokio::task::spawn_blocking(move || files.load_owned())
            .await
            .map_err(io::Error::other)?
    }
    fn load_owned(&self) -> io::Result<Arc<ServerConfig>> {
        let key = self.material(&self.private_key)?;
        let certificates = self.material(&self.certificate)?;
        let chain = CertificateDer::pem_slice_iter(&certificates)
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        let private_key = PrivateKeyDer::from_pem_slice(&key).map_err(io::Error::other)?;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut config = ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(io::Error::other)?
            .with_no_client_auth()
            .with_single_cert(chain, private_key)
            .map_err(io::Error::other)?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        config.ignore_client_order = true;
        Ok(Arc::new(config))
    }
    fn material(&self, path: &Path) -> io::Result<Vec<u8>> {
        material_with_close(path, |file| {
            nix::unistd::close(file).map_err(io::Error::from)?;
            #[cfg(test)]
            if self.fail_material_close {
                return Err(io::Error::other("injected TLS material close failure"));
            }
            Ok(())
        })
    }
    #[cfg(test)]
    pub(crate) fn with_material_close_failure(mut self) -> Self {
        self.fail_material_close = true;
        self
    }
}
fn material_with_close(
    path: &Path,
    finish: impl FnOnce(File) -> io::Result<()>,
) -> io::Result<Vec<u8>> {
    // Following an installed symlink matches Node's readFileSync. A FIFO/device
    // cannot hold an actor bind indefinitely: open is nonblocking, then regular-only.
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)?;
    let bytes = read_material(&mut file);
    let close = finish(file);
    match (bytes, close) {
        (Ok(bytes), Ok(())) => Ok(bytes),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(close)) => Err(io::Error::new(
            primary.kind(),
            format!("{primary}; TLS material close also failed: {close}"),
        )),
    }
}
fn read_material(file: &mut File) -> io::Result<Vec<u8>> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MATERIAL_BYTES {
        return Err(invalid("TLS material must be a bounded regular file"));
    }
    let mut bytes = Vec::new();
    file.take(MATERIAL_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MATERIAL_BYTES {
        return Err(invalid("TLS material exceeds bound"));
    }
    Ok(bytes)
}
pub(crate) struct TlsBudget {
    incoming: ByteLease,
    _outgoing: ByteLease,
}
impl TlsBudget {
    pub(crate) fn reserve(incoming: &BytePool, outgoing: &BytePool) -> Option<Self> {
        // Leave one maximum payload window; overhead must not consume every
        // byte needed for the admitted transport to make application progress.
        if incoming.available() < HANDSHAKE_RESERVE as usize + APPLICATION_OUTPUT
            || outgoing.available() < TLS_RESERVE as usize + APPLICATION_OUTPUT
        {
            return None;
        }
        let amount = NonZeroU32::new(TLS_RESERVE).expect("nonzero TLS reserve");
        Some(Self {
            incoming: incoming
                .reserve(NonZeroU32::new(HANDSHAKE_RESERVE).expect("nonzero handshake reserve"))?,
            _outgoing: outgoing.reserve(amount)?,
        })
    }
    fn established(&mut self) {
        let live = self
            .incoming
            .split(NonZeroU32::new(TLS_RESERVE).expect("nonzero TLS reserve"))
            .expect("handshake budget covers established transport");
        self.incoming = live;
    }
}
pub(crate) async fn handshake(
    socket: TcpStream,
    config: Arc<ServerConfig>,
    budget: TlsBudget,
    scratch: Arc<SharedScratch>,
) -> io::Result<Transport> {
    let wire = Wire {
        socket,
        input: 0,
        maximum: HANDSHAKE_INPUT,
        _budget: budget,
    };
    let accepted = TlsAcceptor::from(config).accept_with(wire, |session| {
        session.set_buffer_limit(Some(APPLICATION_OUTPUT));
    });
    let mut stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, accepted)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "TLS handshake deadline"))??;
    stream.get_mut().0.input = 0;
    stream.get_mut().0.maximum = CONTROL_INPUT;
    stream.get_mut().0._budget.established();
    Ok(Box::new(Encrypted {
        stream,
        reading: scratch.waiter(),
        writing: scratch.waiter(),
        flushing: scratch.waiter(),
        shutting_down: scratch.waiter(),
    }))
}
struct Wire {
    socket: TcpStream,
    input: usize,
    maximum: usize,
    _budget: TlsBudget,
}
impl AsyncRead for Wire {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let available = self.maximum.saturating_sub(self.input);
        if available == 0 {
            return Poll::Ready(Err(invalid("TLS control input exceeds bound")));
        }
        let amount = available.min(buffer.remaining());
        let mut limited = ReadBuf::new(buffer.initialize_unfilled_to(amount));
        match Pin::new(&mut self.socket).poll_read(cx, &mut limited) {
            Poll::Ready(Ok(())) => {
                let count = limited.filled().len();
                self.input += count;
                buffer.advance(count);
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}
impl AsyncWrite for Wire {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.socket).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}
struct Encrypted {
    stream: TlsStream<Wire>,
    reading: ScratchWait,
    writing: ScratchWait,
    flushing: ScratchWait,
    shutting_down: ScratchWait,
}
impl AsyncRead for Encrypted {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.as_mut().get_mut();
        let _parser = std::task::ready!(this.reading.poll(cx))?;
        let before = buffer.filled().len();
        let result = Pin::new(&mut this.stream).poll_read(cx, buffer);
        if matches!(result, Poll::Ready(Ok(()))) && buffer.filled().len() > before {
            this.stream.get_mut().0.input = 0;
        }
        result
    }
}
impl AsyncWrite for Encrypted {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.as_mut().get_mut();
        let _parser = std::task::ready!(this.writing.poll(cx))?;
        Pin::new(&mut this.stream).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.as_mut().get_mut();
        let _parser = std::task::ready!(this.flushing.poll(cx))?;
        Pin::new(&mut this.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.as_mut().get_mut();
        let _parser = std::task::ready!(this.shutting_down.poll(cx))?;
        Pin::new(&mut this.stream).poll_shutdown(cx)
    }
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
