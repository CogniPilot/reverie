//! One connection, in the legacy handler's order: stopping check, a 10 s
//! socket timeout, the kernel peer UID before any frame, then one frame
//! dispatched to its owner. T is handed over whole, before its frame is read.
use super::{BrokerCore, InjectedKind, Owners, Refusal, StreamOwner, refusal_text};
use reverie_contracts::broker_control::{self, ControlRefusal, ControlRoute};
use reverie_host::broker_listener::{self, FrameError};
use std::{
    os::unix::net::UnixStream,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const SOCKET_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) fn handle(
    core: &dyn BrokerCore,
    owners: &Owners,
    closing: &AtomicBool,
    mut stream: UnixStream,
) {
    let outcome = match admit(core, closing, &stream) {
        Ok(peer) => match broker_listener::peek_kind(&stream) {
            Ok(b'T') => {
                core.report(stream);
                return;
            }
            Ok(_) => frame(core, owners, &mut stream, peer),
            Err(error) => Err(frame_refusal(error)),
        },
        Err(refusal) => Err(refusal),
    };
    if let Err(refusal) = outcome
        && refusal != Refusal::Closed
    {
        let payload = broker_listener::error_payload(&refusal_text(&refusal));
        let _ = broker_listener::write_frame(&mut stream, b'E', &payload);
    }
}
fn admit(core: &dyn BrokerCore, closing: &AtomicBool, stream: &UnixStream) -> Result<u32, Refusal> {
    if closing.load(Ordering::Acquire) {
        return Err(Refusal::Message("Worker broker is stopping".into()));
    }
    stream
        .set_read_timeout(Some(SOCKET_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(SOCKET_TIMEOUT)))
        .map_err(|_| Refusal::Transport)?;
    let peer = broker_listener::peer_uid(stream).map_err(|_| Refusal::Transport)?;
    if peer != core.uid() {
        return Err(Refusal::Message(
            "Worker peer identity is not authorized".into(),
        ));
    }
    Ok(peer)
}
fn frame(
    core: &dyn BrokerCore,
    owners: &Owners,
    stream: &mut UnixStream,
    peer: u32,
) -> Result<(), Refusal> {
    let (kind, raw) = broker_listener::read_frame(stream).map_err(frame_refusal)?;
    let injected = |kind: InjectedKind| owners.get(kind).cloned();
    match kind {
        b'M' => owned(injected(InjectedKind::ChatImages), stream, &raw, peer),
        b'Y' => owned(injected(InjectedKind::HostResume), stream, &raw, peer),
        b'Q' => owned(injected(InjectedKind::ResourceActor), stream, &raw, peer),
        b'G' => owned(injected(InjectedKind::GoalCustody), stream, &raw, peer),
        b'C' => match broker_control::route(&raw) {
            Ok(ControlRoute::ResumeChannel) => match injected(InjectedKind::HostResume) {
                Some(owner) => owned(Some(owner), stream, &raw, peer),
                None => Err(Refusal::Message(
                    "Native host recovery is unavailable".into(),
                )),
            },
            Ok(route) => {
                let reply = core.control(route, &raw, peer)?;
                send(stream, &reply.encode())
            }
            Err(ControlRefusal::Message(text)) => Err(Refusal::Message(text.into())),
            Err(ControlRefusal::Transport) => Err(Refusal::Transport),
            // The named difference: a fixed refusal, not the decoder's text.
            Err(ControlRefusal::InvalidJson) => {
                Err(Refusal::Message(broker_control::UNDECODABLE_REFUSAL.into()))
            }
        },
        b'J' | b'L' => core.launch(kind, stream, &raw, peer),
        _ => Err(Refusal::Message("Expected worker launch request".into())),
    }
}
fn owned(
    owner: Option<Arc<dyn StreamOwner>>,
    stream: &mut UnixStream,
    raw: &[u8],
    peer: u32,
) -> Result<(), Refusal> {
    // Preflight refuses a service without every owner; this is only defensive.
    let owner = owner.ok_or(Refusal::Transport)?;
    match owner.serve(stream, raw, peer)? {
        Some(reply) => send(stream, &reply.encode()),
        None => Ok(()),
    }
}
fn send(stream: &mut UnixStream, payload: &[u8]) -> Result<(), Refusal> {
    broker_listener::write_frame(stream, b'J', payload).map_err(frame_refusal)
}
fn frame_refusal(error: FrameError) -> Refusal {
    match error {
        FrameError::Closed => Refusal::Closed,
        FrameError::TooLarge => Refusal::Message("Worker frame is too large".into()),
        FrameError::Io(_) => Refusal::Transport,
    }
}
