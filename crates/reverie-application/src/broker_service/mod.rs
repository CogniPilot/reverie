//! The native broker service: listener, admission, per-connection dispatch and
//! whole-service close, in the legacy broker's order. It owns no engine effect,
//! storage, laptop or Office; those stay with the borrowed `BrokerCore` and the
//! injected stream owners. Broker close starts only from `request_close`
//! (the signal path); the office-power C actions never reach it.
mod close;
mod dispatch;
pub mod power;
#[cfg(test)]
mod tests;
pub mod watchdog;
use reverie_contracts::{broker_control::ControlRoute, broker_reply::BrokerReply};
use reverie_host::broker_listener::{self, BoundSocket};
use std::{
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// An E reply, a fixed transport failure, or a closed peer that gets nothing.
#[derive(Debug, Eq, PartialEq)]
pub enum Refusal {
    Message(String),
    Transport,
    Closed,
}

/// A frame kind whose legacy owner has no native replacement in this crate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InjectedKind {
    /// M: worker chat images.
    ChatImages,
    /// Y: host worker resume registration and its owner channel.
    HostResume,
    /// Q: the protected resource-replacement actor.
    ResourceActor,
    /// G: owner-only goal custody.
    GoalCustody,
}
impl InjectedKind {
    pub const ALL: [Self; 4] = [
        Self::ChatImages,
        Self::HostResume,
        Self::ResourceActor,
        Self::GoalCustody,
    ];
    pub fn frame(self) -> u8 {
        match self {
            Self::ChatImages => b'M',
            Self::HostResume => b'Y',
            Self::ResourceActor => b'Q',
            Self::GoalCustody => b'G',
        }
    }
}

/// An owner of one frame kind. It may stream on the connection; a one-shot
/// reply is returned for the service to frame as J.
pub trait StreamOwner: Send + Sync {
    fn serve(
        &self,
        stream: &mut UnixStream,
        payload: &[u8],
        peer_uid: u32,
    ) -> Result<Option<BrokerReply>, Refusal>;
}

/// The four injected owners. A missing one refuses startup before any effect.
#[derive(Clone, Default)]
pub struct Owners {
    pub chat_images: Option<Arc<dyn StreamOwner>>,
    pub host_resume: Option<Arc<dyn StreamOwner>>,
    pub resource_actor: Option<Arc<dyn StreamOwner>>,
    pub goal_custody: Option<Arc<dyn StreamOwner>>,
}
impl Owners {
    fn get(&self, kind: InjectedKind) -> Option<&Arc<dyn StreamOwner>> {
        match kind {
            InjectedKind::ChatImages => self.chat_images.as_ref(),
            InjectedKind::HostResume => self.host_resume.as_ref(),
            InjectedKind::ResourceActor => self.resource_actor.as_ref(),
            InjectedKind::GoalCustody => self.goal_custody.as_ref(),
        }
    }
}

/// The installing broker's effects, borrowed in the legacy order. Each close
/// step returns whether it was confirmed; the service turns refusals into the
/// legacy uncertainty codes.
pub trait BrokerCore: Send + Sync {
    fn uid(&self) -> u32;
    fn connection_limit(&self) -> usize;
    fn check_pool(&self) -> Result<(), Refusal>;
    fn recover(&self) -> Result<(), Refusal>;
    /// A configured lease peer that fails to start records its own error.
    fn start_lease_peer(&self);
    /// The watchdog loop; it returns once `closed` is set.
    fn watchdog(&self, closed: &AtomicBool);
    /// T: the existing report service reads its own frame from the stream.
    fn report(&self, stream: UnixStream);
    /// J and L: launch or attach, owning the interaction relay.
    fn launch(
        &self,
        kind: u8,
        stream: &mut UnixStream,
        payload: &[u8],
        peer_uid: u32,
    ) -> Result<(), Refusal>;
    /// Routed C requests other than the resume channel.
    fn control(
        &self,
        route: ControlRoute,
        raw: &[u8],
        peer_uid: u32,
    ) -> Result<BrokerReply, Refusal>;
    /// The single first-stop budget; repeated calls never extend it.
    fn request_stop(&self) -> Instant;
    /// Whether the process was asked to stop, for example by a termination
    /// signal observed on the installed engine. `serve` polls it with its
    /// accept loop, as the legacy serve() loop checked `stopping`, and closes.
    fn stop_requested(&self) -> bool {
        false
    }
    fn close_lease_peer(&self) -> bool;
    fn request_office_close(&self) -> bool;
    fn close_offices(&self, deadline: Instant) -> bool;
    fn reap_viewers(&self);
    /// Owned clients, chat images and the report service; failed codes.
    fn settle(&self, deadline: Instant) -> Vec<&'static str>;
}

#[derive(Debug, Eq, PartialEq)]
pub enum ServiceError {
    /// Startup refused before any effect: the missing injected kinds.
    Incomplete(Vec<InjectedKind>),
    /// A startup step refused. `cleanup` holds the legacy codes of any close
    /// that ran for effects already started; empty means it was confirmed.
    Startup {
        cause: String,
        cleanup: Vec<&'static str>,
    },
    /// Close was not confirmed: exactly the recorded legacy codes.
    Unconfirmed(Vec<&'static str>),
}

const ACCEPT_POLL: Duration = Duration::from_millis(500);
const DRAIN: Duration = Duration::from_secs(25);

struct Record {
    stream: UnixStream,
    handle: JoinHandle<()>,
}
/// The close attempts this service owns until they are observed settled: the
/// one first-stop deadline, the one lease-close attempt and the watchdog.
/// A failed join stays recorded; a missing handle never means settled.
#[derive(Default)]
struct Retained {
    deadline: Option<Instant>,
    watchdog: Option<JoinHandle<()>>,
    watchdog_failed: bool,
    lease_started: bool,
    lease: Option<JoinHandle<bool>>,
    lease_failed: bool,
}
pub struct BrokerService {
    core: Arc<dyn BrokerCore>,
    owners: Owners,
    socket: PathBuf,
    closing: Arc<AtomicBool>,
    records: Arc<Mutex<Vec<Record>>>,
    admitted: Arc<Mutex<usize>>,
    retained: Mutex<Retained>,
}
impl BrokerService {
    pub fn new(core: Arc<dyn BrokerCore>, owners: Owners, socket: PathBuf) -> Self {
        Self {
            core,
            owners,
            socket,
            closing: Arc::new(AtomicBool::new(false)),
            records: Arc::new(Mutex::new(Vec::new())),
            admitted: Arc::new(Mutex::new(0)),
            retained: Mutex::new(Retained::default()),
        }
    }
    /// The signal path: ask a running `serve` to stop accepting and close.
    pub fn request_close(&self) {
        self.closing.store(true, Ordering::Release);
    }
    pub fn closing_flag(&self) -> Arc<AtomicBool> {
        self.closing.clone()
    }
    /// Closing was asked for, by `request_close` or by a stop the core reports.
    /// `close` then sets the closing flag itself.
    fn stopping(&self) -> bool {
        self.core.stop_requested() || self.closing.load(Ordering::Acquire)
    }
    /// No effect at all: every injected owner must be present.
    pub fn preflight(&self) -> Result<(), ServiceError> {
        let missing: Vec<_> = InjectedKind::ALL
            .into_iter()
            .filter(|kind| self.owners.get(*kind).is_none())
            .collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(ServiceError::Incomplete(missing))
        }
    }
    /// Start in the legacy order, accept until `request_close`, then close.
    pub fn serve(&self) -> Result<(), ServiceError> {
        self.preflight()?;
        // Before recovery nothing needs cleanup, as in the legacy serve().
        let early = |cause: String| ServiceError::Startup {
            cause,
            cleanup: Vec::new(),
        };
        self.core
            .check_pool()
            .map_err(|error| early(refusal_text(&error)))?;
        broker_listener::prepare_directory(&self.socket)
            .map_err(|error| early(error.message().into()))?;
        broker_listener::clear_stale(&self.socket)
            .map_err(|error| early(error.message().into()))?;
        self.core
            .recover()
            .map_err(|error| early(refusal_text(&error)))?;
        // From here the legacy try/finally owns cleanup on every exit.
        if self.stopping() {
            return self.close(None);
        }
        self.core.start_lease_peer();
        let watchdog = {
            let core = self.core.clone();
            let closing = self.closing.clone();
            std::thread::Builder::new().spawn(move || core.watchdog(&closing))
        };
        match watchdog {
            Ok(handle) => self.retain().watchdog = Some(handle),
            Err(_) => self.retain().watchdog_failed = true,
        }
        let mut bound = match BoundSocket::bind(&self.socket) {
            Ok(bound) => bound,
            Err(error) => {
                let cleanup = match self.close(None) {
                    Ok(()) => Vec::new(),
                    Err(ServiceError::Unconfirmed(codes)) => codes,
                    Err(_) => vec!["CLEANUP_UNCONFIRMED"],
                };
                return Err(ServiceError::Startup {
                    cause: error.message().into(),
                    cleanup,
                });
            }
        };
        self.accept(&bound);
        let result = self.close(Some(&mut bound));
        drop(bound);
        result
    }
    fn accept(&self, bound: &BoundSocket) {
        let Ok(listener) = bound.listener() else {
            return;
        };
        if listener.set_nonblocking(true).is_err() {
            return;
        }
        let limit = self.core.connection_limit();
        while !self.stopping() {
            let stream = match listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(ACCEPT_POLL.min(Duration::from_millis(20)));
                    continue;
                }
                Err(_) => continue,
            };
            self.admit(stream, limit);
        }
    }
    fn admit(&self, stream: UnixStream, limit: usize) {
        // The legacy semaphore: try to take a permit, close when none is left.
        {
            let Ok(mut admitted) = self.admitted.lock() else {
                return;
            };
            if *admitted >= limit {
                return;
            }
            *admitted += 1;
        }
        let release = |admitted: &Mutex<usize>| {
            if let Ok(mut count) = admitted.lock() {
                *count = count.saturating_sub(1);
            }
        };
        if self.closing.load(Ordering::Acquire) || stream.set_nonblocking(false).is_err() {
            release(&self.admitted);
            return;
        }
        // Finished handlers are joined as new ones arrive, so the records
        // hold only live connections while the service runs.
        self.join_finished();
        let Ok(shutdown_handle) = stream.try_clone() else {
            release(&self.admitted);
            return;
        };
        let core = self.core.clone();
        let owners = self.owners.clone();
        let closing = self.closing.clone();
        let admitted = self.admitted.clone();
        let spawned = std::thread::Builder::new().spawn(move || {
            dispatch::handle(core.as_ref(), &owners, &closing, stream);
            release(&admitted);
        });
        match spawned {
            // A poisoned lock is recovered so the handler's owner is kept.
            Ok(handle) => self.records().push(Record {
                stream: shutdown_handle,
                handle,
            }),
            Err(_) => release(&self.admitted),
        }
    }
}
impl BrokerService {
    fn records(&self) -> std::sync::MutexGuard<'_, Vec<Record>> {
        self.records
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn retain(&self) -> std::sync::MutexGuard<'_, Retained> {
        self.retained
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
pub(crate) fn refusal_text(refusal: &Refusal) -> String {
    match refusal {
        Refusal::Message(text) => text.clone(),
        Refusal::Transport | Refusal::Closed => broker_listener::TRANSPORT_FAILED.into(),
    }
}
