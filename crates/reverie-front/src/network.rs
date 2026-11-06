//! One bounded read request and one socket write per client. Every task has an
//! owned cancellation/join path; no client can block draining the shared channel.
use crate::{
    budget::ByteLease,
    outbox::{StreamPacket, StreamQueue},
};
use std::io;
use tokio::{
    io::{AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpStream, tcp::OwnedReadHalf},
    sync::mpsc,
    task::JoinHandle,
};

pub(crate) enum NetworkEvent {
    Read {
        id: u64,
        bytes: Vec<u8>,
        lease: ByteLease,
        result: io::Result<usize>,
    },
    Written {
        id: u64,
        bytes: usize,
        ended: bool,
        result: io::Result<()>,
    },
}
pub(crate) struct Client {
    pub read: mpsc::Sender<ByteLease>,
    pub write: mpsc::Sender<StreamPacket>,
    pub pending: StreamQueue,
    pub grant: Option<ByteLease>,
    pub credit: u64,
    pub reading: bool,
    pub writing: bool,
    pub read_ended: bool,
    pub write_ended: bool,
    pub grant_queued: bool,
    pub read_queued: bool,
    pub written: u64,
    pub acknowledged: u64,
    tasks: ClientTasks,
}
struct ClientTasks {
    reader: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<()>>,
}
impl Drop for ClientTasks {
    fn drop(&mut self) {
        if let Some(reader) = &self.reader {
            reader.abort();
        }
        if let Some(writer) = &self.writer {
            writer.abort();
        }
    }
}
impl Client {
    pub(crate) fn start(id: u64, socket: TcpStream, events: mpsc::Sender<NetworkEvent>) -> Self {
        let (read_half, write_half) = socket.into_split();
        let (read, read_rx) = mpsc::channel(1);
        let (write, write_rx) = mpsc::channel(1);
        let reader = tokio::spawn(read_loop(id, read_half, read_rx, events.clone()));
        let writer = tokio::spawn(write_loop(id, write_half, write_rx, events));
        Self {
            read,
            write,
            pending: StreamQueue::default(),
            grant: None,
            credit: 0,
            reading: false,
            writing: false,
            read_ended: false,
            write_ended: false,
            grant_queued: false,
            read_queued: false,
            written: 0,
            acknowledged: 0,
            tasks: ClientTasks {
                reader: Some(reader),
                writer: Some(writer),
            },
        }
    }
    pub(crate) fn pump_write(&mut self) -> io::Result<()> {
        if self.writing {
            return Ok(());
        }
        let Some(packet) = self.pending.pop() else {
            return Ok(());
        };
        self.write.try_send(packet).map_err(io::Error::other)?;
        self.writing = true;
        Ok(())
    }
    pub(crate) async fn close(mut self) {
        let reader = self.tasks.reader.take().expect("owned reader");
        let writer = self.tasks.writer.take().expect("owned writer");
        reader.abort();
        writer.abort();
        // Joins prove both socket halves have dropped before releasing the
        // retained transport's place in the generation connection bound.
        let _ = reader.await;
        let _ = writer.await;
    }
}
async fn read_loop(
    id: u64,
    mut socket: OwnedReadHalf,
    mut input: mpsc::Receiver<ByteLease>,
    events: mpsc::Sender<NetworkEvent>,
) {
    while let Some(lease) = input.recv().await {
        let mut bytes = vec![0; lease.bytes()];
        let result = socket.read(&mut bytes).await;
        let terminal = !matches!(result, Ok(size) if size > 0);
        if let Ok(size) = result.as_ref() {
            bytes.truncate(*size);
        }
        if events
            .send(NetworkEvent::Read {
                id,
                bytes,
                lease,
                result,
            })
            .await
            .is_err()
            || terminal
        {
            break;
        }
    }
}
async fn write_loop<W: AsyncWrite + Unpin>(
    id: u64,
    mut socket: W,
    mut input: mpsc::Receiver<StreamPacket>,
    events: mpsc::Sender<NetworkEvent>,
) {
    while let Some(packet) = input.recv().await {
        let ended = matches!(packet, StreamPacket::End);
        let bytes = match &packet {
            StreamPacket::Data(data) => data.bytes().len(),
            StreamPacket::End => 0,
        };
        let result = match &packet {
            StreamPacket::Data(data) => write_data(&mut socket, data.bytes()).await,
            StreamPacket::End => socket.shutdown().await,
        };
        drop(packet);
        let failed = result.is_err();
        if events
            .send(NetworkEvent::Written {
                id,
                bytes,
                ended,
                result,
            })
            .await
            .is_err()
            || ended
            || failed
        {
            break;
        }
    }
}

async fn write_data<W: AsyncWrite + Unpin>(socket: &mut W, bytes: &[u8]) -> io::Result<()> {
    socket.write_all(bytes).await?;
    // Plain TCP flushes immediately. Buffered transports must accept their
    // records at the socket before any receipt or packet charge is released.
    socket.flush().await
}

#[cfg(test)]
mod tests;
