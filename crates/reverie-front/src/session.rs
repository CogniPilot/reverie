//! One child generation, its listeners and every retained network transport.
//! The protocol owns stream ordering; this adapter owns actual reads and writes.
use crate::{
    CONTROL_BYTES, DIRECTION_BYTES, MAX_CONNECTIONS,
    budget::BytePool,
    channel::{Channel, Incoming},
    network::{Client, NetworkEvent, Transport},
    outbox::{ChargedData, Outbox, StreamPacket},
    tls::{
        TlsBudget, TlsFiles,
        pending::{Accepted, Pending},
    },
};
use reverie_contracts::route_frames_v2::{
    AbortReason, Body, Frame, Listener, MAX_DATA_BYTES, Signal, SocketFacts,
    conn::{ConnFrame, ConnTable, Received, Side},
};
use std::{
    collections::{BTreeMap, VecDeque},
    future::pending,
    io,
    num::{NonZeroU32, NonZeroU64},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch},
    task::JoinSet,
    time::Instant,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionEnd {
    ChannelClosed,
    ShutdownDeadline,
    GenerationLost,
}
#[derive(Clone, Copy, Debug)]
pub struct ShutdownRequest {
    signal: Signal,
    deadline: Instant,
}
impl ShutdownRequest {
    pub fn new(signal: Signal) -> Self {
        Self {
            signal,
            deadline: Instant::now() + Duration::from_secs(12),
        }
    }
    pub fn deadline(self) -> Instant {
        self.deadline
    }
}
struct Bound {
    socket: TcpListener,
    accepting: bool,
    tls: Option<std::sync::Arc<rustls::ServerConfig>>,
    epoch: u64,
}
struct ChannelWrite {
    id: u64,
    written: Option<u64>,
}
struct State {
    generation: u64,
    maximum: usize,
    table: ConnTable,
    clients: BTreeMap<u64, Client>,
    listeners: [Option<Bound>; 2],
    binding: [bool; 2],
    binds: JoinSet<BindResult>,
    tls_files: Option<TlsFiles>,
    tls_scratch: Option<std::sync::Arc<crate::tls::scratch::SharedScratch>>,
    handshakes: Pending,
    epoch: u64,
    incoming: BytePool,
    outgoing: BytePool,
    outbox: Outbox,
    grants: VecDeque<u64>,
    readers: VecDeque<u64>,
    channel_write: Option<ChannelWrite>,
    service_ready: bool,
}
impl State {
    fn new(generation: NonZeroU64, maximum: usize, bytes: usize) -> io::Result<Self> {
        Ok(Self {
            generation: generation.get(),
            maximum,
            table: ConnTable::new(Side::Front, maximum),
            clients: BTreeMap::new(),
            listeners: [None, None],
            binding: [false, false],
            binds: JoinSet::new(),
            tls_files: None,
            tls_scratch: None,
            handshakes: Pending::default(),
            epoch: 0,
            incoming: BytePool::new(bytes).map_err(io::Error::other)?,
            outgoing: BytePool::new(bytes).map_err(io::Error::other)?,
            outbox: Outbox::new(generation, CONTROL_BYTES),
            grants: VecDeque::new(),
            readers: VecDeque::new(),
            channel_write: None,
            service_ready: false,
        })
    }
    async fn receive(&mut self, frame: Frame) -> io::Result<()> {
        if frame.generation != self.generation {
            return Err(fault("generation mismatch"));
        }
        if frame.id == 0 {
            return self.lifecycle(frame.body);
        }
        let connection = match &frame.body {
            Body::Data(bytes) => ConnFrame::Data(bytes.len()),
            Body::End => ConnFrame::End,
            Body::Abort(_) => ConnFrame::Abort,
            Body::Credit(bytes) => ConnFrame::Credit(*bytes),
            _ => return Err(fault("unexpected connection kind")),
        };
        let received = self
            .table
            .receive(frame.id, connection)
            .map_err(|e| fault(e.code()))?;
        match received {
            Received::Late { .. } => {
                if matches!(frame.body, Body::Abort(_)) {
                    // The table can close before the retained transport's
                    // shutdown finishes. A late destroy still cancels it.
                    self.remove(frame.id).await;
                }
                Ok(())
            }
            Received::Aborted => {
                self.remove(frame.id).await;
                Ok(())
            }
            Received::Credit(bytes) => {
                let client = self
                    .clients
                    .get_mut(&frame.id)
                    .expect("retained open client");
                client.credit = client
                    .credit
                    .checked_add(u64::from(bytes))
                    .ok_or_else(|| fault("credit overflow"))?;
                self.queue_reader(frame.id);
                Ok(())
            }
            Received::Data(_) => {
                let Body::Data(bytes) = frame.body else {
                    unreachable!()
                };
                self.receive_data(frame.id, bytes)
            }
            Received::Ended { .. } => {
                let client = self
                    .clients
                    .get_mut(&frame.id)
                    .expect("retained open client");
                drop(client.grant.take());
                client
                    .pending
                    .push(StreamPacket::End)
                    .map_err(io::Error::other)
            }
            Received::Opened | Received::Written { .. } => {
                Err(fault("unexpected child connection frame"))
            }
        }
    }
    fn receive_data(&mut self, id: u64, bytes: Vec<u8>) -> io::Result<()> {
        let client = self.clients.get_mut(&id).expect("retained open client");
        let amount = NonZeroU32::new(bytes.len() as u32).ok_or_else(|| fault("empty data"))?;
        let lease = client
            .grant
            .as_mut()
            .ok_or_else(|| fault("ungranted data"))?
            .split(amount)
            .map_err(|_| fault("credit overrun"))?;
        if client
            .grant
            .as_ref()
            .is_some_and(|grant| grant.bytes() == 0)
        {
            drop(client.grant.take());
        }
        let packet = ChargedData::new(bytes, lease).map_err(io::Error::other)?;
        client
            .pending
            .push(StreamPacket::Data(packet))
            .map_err(io::Error::other)?;
        self.queue_grant(id);
        Ok(())
    }
    fn lifecycle(&mut self, body: Body) -> io::Result<()> {
        match body {
            Body::BindRequest {
                listener,
                host,
                port,
                tls,
            } => self.bind(listener, host, port, tls),
            Body::Accepting { listener } => {
                let bound = self.listeners[index(listener)]
                    .as_mut()
                    .ok_or_else(|| fault("accepting before bound"))?;
                if bound.accepting {
                    return Err(fault("duplicate accepting"));
                }
                bound.accepting = true;
                Ok(())
            }
            Body::Unbind { listener } => {
                self.listeners[index(listener)]
                    .take()
                    .ok_or_else(|| fault("unbind before bound"))?;
                self.handshakes.cancel(listener);
                Ok(())
            }
            Body::ServiceReady => {
                if self.service_ready || !self.listeners[0].as_ref().is_some_and(|b| b.accepting) {
                    return Err(fault("invalid service_ready"));
                }
                self.service_ready = true;
                Ok(())
            }
            _ => Err(fault("unexpected lifecycle kind")),
        }
    }
    fn bind(&mut self, listener: Listener, host: String, port: u16, tls: bool) -> io::Result<()> {
        if self.binding[index(listener)] || self.listeners[index(listener)].is_some() {
            return Err(fault("duplicate bind"));
        }
        let files = self.tls_files.clone();
        self.binding[index(listener)] = true;
        self.binds.spawn(async move {
            let result = bind_socket(host, port, tls, files).await;
            (listener, result)
        });
        Ok(())
    }
    fn bound(&mut self, listener: Listener, result: io::Result<BoundSocket>) -> io::Result<()> {
        if !std::mem::replace(&mut self.binding[index(listener)], false) {
            return Err(fault("unexpected bind completion"));
        }
        match result {
            Ok((socket, tls)) => {
                if tls.is_some() && !self.prepare_tls_workspace() {
                    return self.bind_failed(
                        listener,
                        "ENOMEM",
                        "TLS parser workspace unavailable",
                    );
                }
                let port = socket.local_addr()?.port();
                self.epoch = self
                    .epoch
                    .checked_add(1)
                    .ok_or_else(|| fault("bind epoch overflow"))?;
                self.listeners[index(listener)] = Some(Bound {
                    socket,
                    accepting: false,
                    tls,
                    epoch: self.epoch,
                });
                self.outbox
                    .control(0, Body::Bound { listener, port })
                    .map_err(io::Error::other)
            }
            Err(error) => self.bind_failed(listener, errno(&error), &error.to_string()),
        }
    }
    fn bind_failed(&mut self, listener: Listener, errno: &str, message: &str) -> io::Result<()> {
        let mut message = message.to_string();
        while message.len() > 512 {
            message.pop();
        }
        self.outbox
            .control(
                0,
                Body::BindFailed {
                    listener,
                    errno: errno.into(),
                    message,
                },
            )
            .map_err(io::Error::other)
    }
    fn prepare_tls_workspace(&mut self) -> bool {
        if self.tls_scratch.is_none() {
            self.tls_scratch = crate::tls::scratch::SharedScratch::reserve(&self.incoming);
        }
        self.tls_scratch.is_some()
    }
    async fn accepted(
        &mut self,
        listener: Listener,
        socket: TcpStream,
        events: &mpsc::Sender<NetworkEvent>,
    ) -> io::Result<()> {
        if self.clients.len() + self.handshakes.len() >= self.maximum {
            // Includes graceful transports whose final bytes are still draining.
            drop(socket);
            let _ = reverie_diagnostics::stderr(b"reverie-front: connection limit reached\n");
            return Ok(());
        }
        let peer = socket.peer_addr()?;
        let local = socket.local_addr()?;
        let bound = self.listeners[index(listener)]
            .as_ref()
            .expect("accepted bound listener");
        if let Some(config) = &bound.tls {
            if let Some(budget) = TlsBudget::reserve(&self.incoming, &self.outgoing) {
                self.handshakes.start(
                    listener,
                    bound.epoch,
                    socket,
                    config.clone(),
                    budget,
                    self.tls_scratch
                        .as_ref()
                        .expect("TLS bound parser workspace")
                        .clone(),
                )?;
            }
            return Ok(());
        }
        self.open_transport(listener, peer, local, Box::new(socket), false, events)
    }
    fn open_transport(
        &mut self,
        listener: Listener,
        peer: std::net::SocketAddr,
        local: std::net::SocketAddr,
        socket: Transport,
        encrypted: bool,
        events: &mpsc::Sender<NetworkEvent>,
    ) -> io::Result<()> {
        let id = self.table.open_next().map_err(|e| fault(e.code()))?;
        self.outbox
            .control(
                id,
                Body::ConnOpen {
                    listener,
                    peer: SocketFacts {
                        address: peer.ip(),
                        port: peer.port(),
                    },
                    local: SocketFacts {
                        address: local.ip(),
                        port: local.port(),
                    },
                    encrypted,
                },
            )
            .map_err(io::Error::other)?;
        self.clients
            .insert(id, Client::start(id, socket, events.clone()));
        self.queue_grant(id);
        Ok(())
    }
    fn queue_grant(&mut self, id: u64) {
        if let Some(client) = self.clients.get_mut(&id)
            && !client.grant_queued
        {
            client.grant_queued = true;
            self.grants.push_back(id);
        }
    }
    fn queue_reader(&mut self, id: u64) {
        if let Some(client) = self.clients.get_mut(&id)
            && !client.read_queued
            && !client.reading
            && !client.read_ended
            && client.credit > 0
        {
            client.read_queued = true;
            self.readers.push_back(id);
        }
    }
    fn pump(&mut self, channel: &Channel) -> io::Result<()> {
        self.grant_waiters()?;
        self.start_readers()?;
        for client in self.clients.values_mut() {
            client.pump_write()?;
        }
        if self.channel_write.is_none()
            && let Some(frame) = self.outbox.pop()
        {
            self.channel_write = Some(ChannelWrite {
                id: frame.frame().id,
                written: match frame.frame().body {
                    Body::Written(total) => Some(total),
                    _ => None,
                },
            });
            channel.submit(frame)?;
        }
        Ok(())
    }
    fn grant_waiters(&mut self) -> io::Result<()> {
        while self.incoming.available() > 0 {
            let Some(id) = self.grants.pop_front() else {
                break;
            };
            let client = self.clients.get_mut(&id).expect("retained grant waiter");
            client.grant_queued = false;
            if client.pending.ended() {
                continue;
            }
            let held = client.grant.as_ref().map_or(0, |lease| lease.bytes());
            let bytes = self.incoming.available().min(MAX_DATA_BYTES - held);
            let Some(amount) = NonZeroU32::new(bytes as u32) else {
                continue;
            };
            let lease = self.incoming.reserve(amount).expect("available bytes");
            if let Some(grant) = client.grant.as_mut() {
                grant.merge(lease).map_err(io::Error::other)?;
            } else {
                client.grant = Some(lease);
            }
            self.outbox
                .control(id, Body::Credit(amount.get()))
                .map_err(io::Error::other)?;
            if bytes + held < MAX_DATA_BYTES {
                self.queue_grant(id);
            }
        }
        Ok(())
    }
    fn start_readers(&mut self) -> io::Result<()> {
        while self.outgoing.available() > 0 {
            let Some(id) = self.readers.pop_front() else {
                break;
            };
            let client = self.clients.get_mut(&id).expect("retained read waiter");
            client.read_queued = false;
            let bytes = client
                .credit
                .min(MAX_DATA_BYTES as u64)
                .min(self.outgoing.available() as u64) as u32;
            let Some(amount) = NonZeroU32::new(bytes) else {
                continue;
            };
            let lease = self.outgoing.reserve(amount).expect("available bytes");
            client.credit -= u64::from(bytes);
            client.read.try_send(lease).map_err(io::Error::other)?;
            client.reading = true;
        }
        Ok(())
    }
    async fn network(&mut self, event: NetworkEvent) -> io::Result<()> {
        match event {
            NetworkEvent::Read {
                id,
                bytes,
                lease,
                result,
            } => self.read(id, bytes, lease, result).await,
            NetworkEvent::Written {
                id,
                bytes,
                ended,
                result,
            } => {
                if !self.clients.contains_key(&id) {
                    return Ok(());
                }
                if result.is_err() {
                    return self.abort(id).await;
                }
                let client = self.clients.get_mut(&id).expect("retained client");
                client.writing = false;
                client.write_ended |= ended;
                if bytes > 0 {
                    client.written = client
                        .written
                        .checked_add(bytes as u64)
                        .ok_or_else(|| fault("written overflow"))?;
                    self.outbox
                        .control(id, Body::Written(client.written))
                        .map_err(io::Error::other)?;
                }
                Ok(())
            }
        }
    }
    async fn read(
        &mut self,
        id: u64,
        bytes: Vec<u8>,
        mut lease: crate::budget::ByteLease,
        result: io::Result<usize>,
    ) -> io::Result<()> {
        let Some(client) = self.clients.get_mut(&id) else {
            return Ok(());
        };
        client.reading = false;
        let size = match result {
            Ok(size) => size,
            Err(_) => return self.abort(id).await,
        };
        client.credit = client
            .credit
            .checked_add((lease.bytes() - size) as u64)
            .ok_or_else(|| fault("credit overflow"))?;
        if size == 0 {
            client.read_ended = true;
            if self
                .table
                .send(id, ConnFrame::End)
                .map_err(|e| fault(e.code()))?
            {
                self.outbox
                    .stream(id, StreamPacket::End)
                    .map_err(io::Error::other)?;
            }
        } else {
            let charge = lease
                .split(NonZeroU32::new(size as u32).expect("positive read"))
                .map_err(io::Error::other)?;
            let data = ChargedData::new(bytes, charge).map_err(io::Error::other)?;
            if self
                .table
                .send(id, ConnFrame::Data(size))
                .map_err(|e| fault(e.code()))?
            {
                self.outbox
                    .stream(id, StreamPacket::Data(data))
                    .map_err(io::Error::other)?;
            }
            self.queue_reader(id);
        }
        Ok(())
    }
    async fn abort(&mut self, id: u64) -> io::Result<()> {
        self.table
            .send(id, ConnFrame::Abort)
            .map_err(|e| fault(e.code()))?;
        if self.clients.contains_key(&id) {
            // Both ends can be logically queued before our end reaches TS.
            // A socket failure must still publish abort when discarding that
            // pending end, even if the pure connection table already closed.
            self.outbox
                .control(id, Body::Abort(AbortReason::PeerReset))
                .map_err(io::Error::other)?;
        }
        self.remove(id).await;
        Ok(())
    }
    async fn remove(&mut self, id: u64) {
        self.outbox.discard_connection(id);
        self.grants.retain(|queued| *queued != id);
        self.readers.retain(|queued| *queued != id);
        if let Some(client) = self.clients.remove(&id) {
            client.close().await;
        }
    }
    async fn retire_drained(&mut self) {
        let done: Vec<_> = self
            .clients
            .iter()
            .filter_map(|(id, client)| {
                (client.read_ended
                    && client.write_ended
                    && client.written == client.acknowledged
                    && !self.outbox.has_stream(*id)
                    && self
                        .channel_write
                        .as_ref()
                        .is_none_or(|write| write.id != *id))
                .then_some(*id)
            })
            .collect();
        for id in done {
            self.remove(id).await;
        }
    }
    fn channel_finished(&mut self, finished: crate::channel::WriteFinished) -> io::Result<()> {
        finished.result?;
        let write = self
            .channel_write
            .take()
            .ok_or_else(|| fault("unexpected write receipt"))?;
        if write.id != finished.id {
            return Err(fault("write receipt mismatch"));
        }
        if let Some(total) = write.written {
            // The final receipt must reach the channel before it closes the
            // table. A crossing abort may already have retired this client.
            if self
                .table
                .send(write.id, ConnFrame::Written(total))
                .map_err(|error| fault(error.code()))?
                && let Some(client) = self.clients.get_mut(&write.id)
            {
                client.acknowledged = total;
            }
        }
        Ok(())
    }
    async fn close(mut self) {
        self.handshakes.close().await;
        self.listeners = [None, None];
        self.binds.abort_all();
        while self.binds.join_next().await.is_some() {}
        for client in self.clients.into_values() {
            client.close().await;
        }
    }
}
fn index(listener: Listener) -> usize {
    usize::from(listener.byte())
}
fn fault(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
async fn bind_socket(
    host: String,
    port: u16,
    tls: bool,
    files: Option<TlsFiles>,
) -> io::Result<BoundSocket> {
    let config = if tls {
        Some(
            files
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "TLS material is not configured")
                })?
                .load()
                .await?,
        )
    } else {
        None
    };
    let socket = TcpListener::bind((host.as_str(), port)).await?;
    Ok((socket, config))
}
fn errno(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::AddrInUse => "EADDRINUSE",
        io::ErrorKind::AddrNotAvailable => "EADDRNOTAVAIL",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::InvalidInput => "EINVAL",
        _ => "EIO",
    }
}
async fn accept(bound: &Option<Bound>) -> io::Result<TcpStream> {
    match bound.as_ref().filter(|bound| bound.accepting) {
        Some(bound) => bound.socket.accept().await.map(|(socket, _)| socket),
        None => pending().await,
    }
}
async fn deadline(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => pending().await,
    }
}
/// Runs exactly one generation. The installing-service owner subsequently reaps
/// its child, killing at the same absolute shutdown deadline if still alive.
pub async fn run(
    channel: Channel,
    generation: NonZeroU64,
    signals: watch::Receiver<Option<ShutdownRequest>>,
) -> io::Result<SessionEnd> {
    run_bounded(
        channel,
        State::new(generation, MAX_CONNECTIONS, DIRECTION_BYTES)?,
        signals,
    )
    .await
}
async fn run_bounded(
    channel: Channel,
    state: State,
    signals: watch::Receiver<Option<ShutdownRequest>>,
) -> io::Result<SessionEnd> {
    run_owned(channel, state, signals, None).await
}
pub(crate) async fn run_supervised(
    channel: Channel,
    generation: NonZeroU64,
    signals: watch::Receiver<Option<ShutdownRequest>>,
    loss: watch::Receiver<bool>,
    tls_files: Option<TlsFiles>,
) -> io::Result<SessionEnd> {
    let mut state = State::new(generation, MAX_CONNECTIONS, DIRECTION_BYTES)?;
    state.tls_files = tls_files;
    run_owned(channel, state, signals, Some(loss)).await
}
async fn run_owned(
    mut channel: Channel,
    mut state: State,
    mut signals: watch::Receiver<Option<ShutdownRequest>>,
    mut loss: Option<watch::Receiver<bool>>,
) -> io::Result<SessionEnd> {
    let (events, mut network) = mpsc::channel(128);
    let result = drive(
        &mut channel,
        &mut state,
        &mut signals,
        &events,
        &mut network,
        &mut loss,
    )
    .await;
    if matches!(result, Ok(SessionEnd::GenerationLost)) {
        let _ = channel.stop_output();
    }
    state.close().await;
    drop(network);
    let result = match result {
        Ok(SessionEnd::GenerationLost) => drain_codec(&mut channel)
            .await
            .map(|()| SessionEnd::GenerationLost),
        other => other,
    };
    let cleanup = channel.finish().await;
    match result {
        Ok(end) => cleanup.map(|()| end),
        Err(error) => Err(error),
    }
}
async fn drive(
    channel: &mut Channel,
    state: &mut State,
    signals: &mut watch::Receiver<Option<ShutdownRequest>>,
    events: &mpsc::Sender<NetworkEvent>,
    network: &mut mpsc::Receiver<NetworkEvent>,
    loss: &mut Option<watch::Receiver<bool>>,
) -> io::Result<SessionEnd> {
    let mut control = Control {
        shutdown: None,
        signals_open: true,
    };
    loop {
        if loss.as_ref().is_some_and(|lost| *lost.borrow()) {
            return Ok(SessionEnd::GenerationLost);
        }
        state.retire_drained().await;
        state.pump(channel)?;
        let event = tokio::select! {
            biased;
            () = generation_lost(loss) => return Ok(SessionEnd::GenerationLost),
            event = next_event(channel, state, signals, network, &control) => event,
        };
        if let Some(end) = handle_event(state, signals, events, &mut control, event).await? {
            return Ok(end);
        }
    }
}
struct Control {
    shutdown: Option<Instant>,
    signals_open: bool,
}
type BoundSocket = (TcpListener, Option<std::sync::Arc<rustls::ServerConfig>>);
type BindResult = (Listener, io::Result<BoundSocket>);
enum Event {
    Input(Option<Incoming>),
    Output(Option<crate::channel::WriteFinished>),
    Accepted(Listener, io::Result<TcpStream>),
    Bound(Option<Result<BindResult, tokio::task::JoinError>>),
    Handshake(Option<Accepted>),
    Network(Option<NetworkEvent>),
    Wake,
    Signal(bool),
    Deadline,
}
async fn next_event(
    channel: &mut Channel,
    state: &mut State,
    signals: &mut watch::Receiver<Option<ShutdownRequest>>,
    network: &mut mpsc::Receiver<NetworkEvent>,
    control: &Control,
) -> Event {
    tokio::select! {
        incoming = channel.incoming.recv() => Event::Input(incoming),
        finished = channel.finished.recv(), if state.channel_write.is_some() => Event::Output(finished),
        socket = accept(&state.listeners[0]) => Event::Accepted(Listener::Main, socket),
        socket = accept(&state.listeners[1]) => Event::Accepted(Listener::Bridge, socket),
        bound = state.binds.join_next(), if !state.binds.is_empty() => Event::Bound(bound),
        accepted = state.handshakes.next(), if state.handshakes.len() > 0 => Event::Handshake(accepted),
        event = network.recv() => Event::Network(event),
        () = state.incoming.changed() => Event::Wake,
        () = state.outgoing.changed() => Event::Wake,
        changed = signals.changed(), if control.signals_open => Event::Signal(changed.is_ok()),
        () = deadline(control.shutdown) => Event::Deadline,
    }
}
async fn handle_event(
    state: &mut State,
    signals: &mut watch::Receiver<Option<ShutdownRequest>>,
    events: &mpsc::Sender<NetworkEvent>,
    control: &mut Control,
    event: Event,
) -> io::Result<Option<SessionEnd>> {
    match event {
        Event::Input(input) => {
            let Incoming { frame, receipt } =
                input.ok_or_else(|| fault("channel reader stopped"))?;
            let Some(frame) = frame.map_err(frame_error)? else {
                return Ok(Some(SessionEnd::ChannelClosed));
            };
            state.receive(frame).await?;
            let _ = receipt.send(());
        }
        Event::Output(output) => {
            let finished = output.ok_or_else(|| fault("channel writer stopped"))?;
            state.channel_finished(finished)?;
        }
        Event::Accepted(listener, socket) => state.accepted(listener, socket?, events).await?,
        Event::Handshake(Some(accepted)) => {
            if state.listeners[index(accepted.listener)]
                .as_ref()
                .is_some_and(|b| b.epoch == accepted.epoch)
            {
                state.open_transport(
                    accepted.listener,
                    accepted.peer,
                    accepted.local,
                    accepted.transport,
                    true,
                    events,
                )?;
            }
        }
        Event::Handshake(None) => {}
        Event::Bound(bound) => {
            let (listener, result) = bound
                .ok_or_else(|| fault("bind owner stopped"))?
                .map_err(io::Error::other)?;
            state.bound(listener, result)?;
        }
        Event::Network(event) => {
            state
                .network(event.ok_or_else(|| fault("network stopped"))?)
                .await?
        }
        Event::Wake => {}
        Event::Signal(open) => {
            control.signals_open = open;
            if control.shutdown.is_none()
                && let Some(request) = *signals.borrow_and_update()
            {
                state
                    .outbox
                    .control(
                        0,
                        Body::Shutdown {
                            signal: request.signal,
                        },
                    )
                    .map_err(io::Error::other)?;
                control.shutdown = Some(request.deadline);
            }
        }
        Event::Deadline => return Ok(Some(SessionEnd::ShutdownDeadline)),
    }
    Ok(None)
}
async fn generation_lost(loss: &mut Option<watch::Receiver<bool>>) {
    let Some(loss) = loss else {
        return pending().await;
    };
    loop {
        let gone = *loss.borrow_and_update();
        if gone || loss.changed().await.is_err() {
            return;
        }
    }
}
async fn drain_codec(channel: &mut Channel) -> io::Result<()> {
    let drained = async {
        while let Some(Incoming { frame, receipt }) = channel.incoming.recv().await {
            if frame.map_err(frame_error)?.is_none() {
                return Ok(());
            }
            // Validate only framing after transports are closed: no request can
            // bind a socket or deliver queued bytes into the dead generation.
            let _ = receipt.send(());
        }
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(2), drained)
        .await
        .unwrap_or(Ok(()))
}
fn frame_error(error: reverie_contracts::route_frames_v2::FrameError) -> io::Error {
    use reverie_contracts::route_frames_v2::FrameError;
    let kind = match error {
        FrameError::Io => io::ErrorKind::BrokenPipe,
        FrameError::Truncated => io::ErrorKind::UnexpectedEof,
        _ => io::ErrorKind::InvalidData,
    };
    io::Error::new(kind, error)
}

#[cfg(test)]
mod tests;
