//! Dedicated blocking channel threads reuse the contract's early checked reader.
//! Exactly one unacknowledged input frame and one output frame may be in flight.
//! Socket shutdown unblocks I/O; dropping the input receiver unblocks its receipt.
use crate::outbox::QueuedFrame;
use reverie_contracts::route_frames_v2::{Direction, Frame, FrameError, read_frame};
use std::{
    io::{self, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc as receipt_channel,
    },
    thread,
    time::Duration,
};
use tokio::sync::mpsc;

#[derive(Debug)]
pub struct Incoming {
    pub frame: Result<Option<Frame>, FrameError>,
    pub(crate) receipt: receipt_channel::Sender<()>,
}
impl Incoming {
    /// Call only after validation and consumption of this input. Dropping it
    /// instead ends the reader, so a failed generation cannot read ahead.
    pub fn acknowledge(self) {
        let _ = self.receipt.send(());
    }
}
#[derive(Debug)]
pub struct WriteFinished {
    pub id: u64,
    pub result: io::Result<()>,
}
pub struct Channel {
    pub incoming: mpsc::Receiver<Incoming>,
    pub finished: mpsc::Receiver<WriteFinished>,
    outgoing: mpsc::Sender<QueuedFrame>,
    threads: Threads,
}
struct Threads {
    socket: UnixStream,
    stop: Arc<AtomicBool>,
    reader: Option<thread::JoinHandle<()>>,
    writer: Option<thread::JoinHandle<()>>,
}
impl Threads {
    fn shutdown(&self) -> io::Result<()> {
        self.stop.store(true, Ordering::Release);
        self.socket.shutdown(Shutdown::Both)
    }
}
impl Drop for Threads {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
impl Channel {
    pub fn start(socket: UnixStream) -> io::Result<Self> {
        // Never change O_NONBLOCK on a clone: all clones share that flag.
        let read_socket = socket.try_clone()?;
        let write_socket = socket.try_clone()?;
        let (input_tx, incoming) = mpsc::channel(1);
        let (outgoing, output_rx) = mpsc::channel(1);
        let (done_tx, finished) = mpsc::channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let read_stop = stop.clone();
        let reader = thread::Builder::new()
            .name("front-channel-read".into())
            .spawn(move || read_loop(read_socket, input_tx, read_stop))?;
        let writer = match thread::Builder::new()
            .name("front-channel-write".into())
            .spawn(move || write_loop(write_socket, output_rx, done_tx))
        {
            Ok(writer) => writer,
            Err(error) => {
                let _ = socket.shutdown(Shutdown::Both);
                drop(incoming);
                let _ = reader.join();
                return Err(error);
            }
        };
        Ok(Self {
            incoming,
            finished,
            outgoing,
            threads: Threads {
                socket,
                stop,
                reader: Some(reader),
                writer: Some(writer),
            },
        })
    }
    /// The actor submits only when its previous write completion was received.
    pub fn submit(&self, frame: QueuedFrame) -> io::Result<()> {
        self.outgoing
            .try_send(frame)
            .map_err(|error| io::Error::other(error.to_string()))
    }
    pub(crate) fn stop_output(&self) -> io::Result<()> {
        self.threads.socket.shutdown(Shutdown::Write)
    }
    pub async fn finish(self) -> io::Result<()> {
        let Self {
            incoming,
            finished,
            outgoing,
            mut threads,
        } = self;
        let shutdown = threads.shutdown();
        drop(incoming);
        drop(finished);
        drop(outgoing);
        let reader = threads.reader.take().expect("owned reader");
        let writer = threads.writer.take().expect("owned writer");
        let joined = tokio::task::spawn_blocking(move || (reader.join(), writer.join()))
            .await
            .map_err(io::Error::other)?;
        joined
            .0
            .map_err(|_| io::Error::other("channel reader panicked"))?;
        joined
            .1
            .map_err(|_| io::Error::other("channel writer panicked"))?;
        shutdown
    }
}
fn read_loop(mut socket: UnixStream, output: mpsc::Sender<Incoming>, stop: Arc<AtomicBool>) {
    loop {
        let frame = read_frame(&mut socket, Direction::ToFront);
        let terminal = !matches!(frame, Ok(Some(_)));
        let (receipt, acknowledged) = receipt_channel::channel();
        if output.blocking_send(Incoming { frame, receipt }).is_err() {
            break;
        }
        if !wait_for_receipt(acknowledged, &stop) || terminal {
            break;
        }
    }
}
fn wait_for_receipt(receipt: receipt_channel::Receiver<()>, stop: &AtomicBool) -> bool {
    while !stop.load(Ordering::Acquire) {
        match receipt.recv_timeout(Duration::from_millis(20)) {
            Ok(()) => return true,
            Err(receipt_channel::RecvTimeoutError::Timeout) => {}
            Err(receipt_channel::RecvTimeoutError::Disconnected) => return false,
        }
    }
    false
}
fn write_loop(
    mut socket: UnixStream,
    mut input: mpsc::Receiver<QueuedFrame>,
    output: mpsc::Sender<WriteFinished>,
) {
    while let Some(frame) = input.blocking_recv() {
        let id = frame.frame().id;
        let result = frame
            .encode()
            .map_err(io::Error::other)
            .and_then(|bytes| socket.write_all(&bytes));
        let failed = result.is_err();
        drop(frame); // Release its issued bytes only after the actual write attempt.
        if output.blocking_send(WriteFinished { id, result }).is_err() || failed {
            break;
        }
    }
}

#[cfg(test)]
mod tests;
