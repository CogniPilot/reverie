//! Fixed same-viewer socket/PTY/query/receipt operations. No public fd, argv,
//! PID, path or substitute captured runner is accepted.
use super::*;
use crate::{
    captured_client::{CapturedCall, Policy},
    worker_reports::terminal::{RelayIdentity, RelayTarget, TerminalReady, TerminalWait},
};
use reverie_contracts::{
    storage_identity::MetadataText,
    worker_launch::{ExitReceiptDecoder, ViewerClient},
};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    os::{
        fd::AsFd,
        unix::{fs::OpenOptionsExt, net::UnixStream},
    },
};

pub(super) struct Transport {
    identity: RelayIdentity,
    target: RelayTarget,
    pending: Option<CapturedCall>,
    failure: Option<Arc<LaptopError>>,
}
#[derive(Clone, Copy)]
pub(in crate::worker_laptop) enum Query {
    Clients,
    Environment(ViewerClient),
    PaneDead,
}
pub(in crate::worker_laptop) enum QueryObservation {
    Value(String),
    Missed,
    Unavailable,
    CleanupUnconfirmed,
}
impl Transport {
    pub(super) fn has_pending_native_work(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(CapturedCall::has_pending_native_work)
    }
    pub(super) fn settle(&mut self, engine: &InstalledWorkerEngine, end: Instant) -> Result<()> {
        if let Some(call) = &self.pending {
            engine
                .engine
                .client
                .settle_call(call, end)
                .map_err(|error| LaptopError::Engine(error.into()))?;
            self.pending = None;
        }
        Ok(())
    }
}
impl Job {
    pub(in crate::worker_laptop) fn terminal_marker(&self) -> String {
        reverie_contracts::worker_launch::viewer_marker_entry(&self.marker)
    }
    pub(in crate::worker_laptop) fn bind_transport(
        &self,
        identity: &RelayIdentity,
        target: RelayTarget,
    ) -> Result<()> {
        need(
            self.source
                .as_ref()
                .is_some_and(|source| source.same(identity)),
            "VIEWER_CONNECTION_CHANGED",
        )?;
        let mut state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        need(
            state.transport.is_none()
                && !self.closing.load(Ordering::Acquire)
                && state.process.handoff_ready(),
            "VIEWER_TRANSPORT_REPLAYED",
        )?;
        state.transport = Some(Transport {
            identity: identity.clone(),
            target,
            pending: None,
            failure: None,
        });
        Ok(())
    }
    fn check_transport(state: &State, identity: &RelayIdentity) -> Result<()> {
        need(
            identity.can_progress()
                && state
                    .transport
                    .as_ref()
                    .is_some_and(|transport| transport.identity.same(identity)),
            "VIEWER_TRANSPORT_ORIGIN",
        )
    }
    pub(in crate::worker_laptop) fn terminal_ready(
        &self,
        identity: &RelayIdentity,
        stream: &UnixStream,
        wait: TerminalWait,
    ) -> Result<TerminalReady> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        Self::check_transport(&state, identity)?;
        need(!self.closing.load(Ordering::Acquire), "VIEWER_CLOSED")?;
        let pty = state
            .pty
            .as_ref()
            .ok_or(LaptopError::Refused("VIEWER_CLOSED"))?;
        let end = self.clamp_deadline(Instant::now() + Duration::from_millis(250))?;
        poll(stream, pty, wait, end)
    }
    pub(in crate::worker_laptop) fn terminal_resize(
        &self,
        identity: &RelayIdentity,
        size: TerminalSize,
    ) -> Result<()> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        Self::check_transport(&state, identity)?;
        need(!self.closing.load(Ordering::Acquire), "VIEWER_CLOSED")?;
        state
            .pty
            .as_ref()
            .ok_or(LaptopError::Refused("VIEWER_CLOSED"))?
            .resize(size)
            .map_err(LaptopError::Io)
    }
    pub(in crate::worker_laptop) fn terminal_signal(&self, identity: &RelayIdentity) -> Result<()> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        Self::check_transport(&state, identity)?;
        need(!self.closing.load(Ordering::Acquire), "VIEWER_CLOSED")?;
        state.process.winch().map_err(LaptopError::Io)
    }
    pub(in crate::worker_laptop) fn terminal_receipt(
        &self,
        identity: &RelayIdentity,
    ) -> Result<Option<Vec<u8>>> {
        let mut state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        Self::check_transport(&state, identity)?;
        let target = &state
            .transport
            .as_ref()
            .expect("checked transport")
            .target
            .exit;
        if !super::super::receipt::is_file(target)? {
            return Ok(None);
        }
        let path = match crate::native::python_path(&target.codepoints()) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => return Ok(None),
            Err(error) => return Err(LaptopError::Io(error)),
        };
        state.receipt = Some(
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_CLOEXEC)
                .open(path)
                .map_err(LaptopError::Io)?,
        );
        let read = read_receipt(state.receipt.as_mut().expect("adopted actual file"));
        let closed = crate::native::close(state.receipt.take().expect("consume actual file once"))
            .map_err(LaptopError::Observation);
        if closed.is_err() {
            state.opaque = true;
        }
        finalized(read, closed).map(Some)
    }
    pub(in crate::worker_laptop) fn terminal_has_receipt(
        &self,
        identity: &RelayIdentity,
    ) -> Result<bool> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        Self::check_transport(&state, identity)?;
        super::super::receipt::is_file(
            &state
                .transport
                .as_ref()
                .expect("checked transport")
                .target
                .exit,
        )
    }
    pub(in crate::worker_laptop) fn terminal_query(
        &self,
        identity: &RelayIdentity,
        query: Query,
        end: Instant,
    ) -> Result<QueryObservation> {
        let mut state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        Self::check_transport(&state, identity)?;
        need(!self.closing.load(Ordering::Acquire), "VIEWER_CLOSED")?;
        let transport = state.transport.as_mut().expect("checked transport");
        if transport.pending.is_some() {
            return Ok(QueryObservation::Missed);
        }
        let Some(cid) = &transport.target.container else {
            return Ok(QueryObservation::Unavailable);
        };
        let args = arguments(cid, query)?;
        let origin = self
            .origin
            .upgrade()
            .ok_or(LaptopError::Refused("VIEWER_ORIGIN_RETAINED"))?;
        let end = self.clamp_deadline(end)?;
        match origin.engine.client.run_scoped(
            args,
            end,
            &origin.cancellation(),
            Policy {
                maximum: end.saturating_duration_since(Instant::now()),
                maximum_output: 4 * 1024 * 1024,
                successful_exit: false,
            },
        ) {
            Ok(output) if output.succeeded => Ok(std::str::from_utf8(&output.stdout)
                .map_or(QueryObservation::Missed, |text| {
                    QueryObservation::Value(text.into())
                })),
            Ok(_) => Ok(QueryObservation::Missed),
            Err(failure) => {
                if failure.call.is_some() && failure.error.is_uncertain() {
                    transport.pending = failure.call;
                    transport.failure = Some(Arc::new(LaptopError::Engine(failure.error.into())));
                    Ok(QueryObservation::CleanupUnconfirmed)
                } else {
                    Ok(QueryObservation::Missed)
                }
            }
        }
    }
    pub(in crate::worker_laptop) fn settle_terminal_queries(&self, end: Instant) -> Result<()> {
        let mut state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        let origin = self
            .origin
            .upgrade()
            .ok_or(LaptopError::Refused("VIEWER_ORIGIN_RETAINED"))?;
        if let Some(transport) = &mut state.transport {
            transport.settle(&origin, self.clamp_deadline(end)?)?;
        }
        Ok(())
    }
}
fn poll(
    stream: &UnixStream,
    pty: &OwnedPty,
    wait: TerminalWait,
    end: Instant,
) -> Result<TerminalReady> {
    use nix::poll::{PollFd, PollFlags, PollTimeout};
    let source = match wait {
        TerminalWait::Read { master: true } => PollFlags::POLLIN,
        TerminalWait::Read { master: false } => PollFlags::empty(),
        TerminalWait::Input => PollFlags::POLLOUT,
    };
    let mut descriptors = [
        PollFd::new(stream.as_fd(), PollFlags::POLLIN),
        PollFd::new(pty.as_fd(), source),
    ];
    loop {
        let remaining = end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(TerminalReady::default());
        }
        let millis = remaining
            .as_millis()
            .saturating_add(u128::from(remaining.subsec_nanos() % 1_000_000 != 0));
        let timeout =
            PollTimeout::try_from(millis).map_err(|_| LaptopError::Refused("VIEWER_POLL_BOUND"))?;
        let polled = match wait {
            TerminalWait::Input => nix::poll::poll(&mut descriptors[1..], timeout),
            TerminalWait::Read { master: false } => nix::poll::poll(&mut descriptors[..1], timeout),
            TerminalWait::Read { master: true } => nix::poll::poll(&mut descriptors, timeout),
        };
        match polled {
            Ok(0) => return Ok(TerminalReady::default()),
            Ok(_) => {
                return Ok(TerminalReady {
                    connection: matches!(wait, TerminalWait::Read { .. })
                        && descriptors[0].revents().is_some_and(|f| !f.is_empty()),
                    master: !matches!(wait, TerminalWait::Read { master: false })
                        && descriptors[1].revents().is_some_and(|f| !f.is_empty()),
                });
            }
            Err(nix::errno::Errno::EINTR) => {}
            Err(error) => return Err(LaptopError::Io(error.into())),
        }
    }
}
fn read_receipt(file: &mut File) -> Result<Vec<u8>> {
    let mut decoder = ExitReceiptDecoder::new();
    let mut buffer = [0; 65536];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => return decoder.finish().map_err(LaptopError::ReceiptData),
            Ok(n) => decoder.push(&buffer[..n]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(LaptopError::Io(error)),
        }
    }
}
fn arguments(cid: &reverie_core::ids::ContainerId, query: Query) -> Result<Vec<OsString>> {
    if let Query::Environment(client) = query {
        return Ok(vec![
            "exec".into(),
            cid.as_str().into(),
            "/bin/cat".into(),
            format!("/proc/{}/environ", client.guest_process_id()).into(),
        ]);
    }
    let command = match query {
        Query::Clients => vec![
            "list-clients",
            "-F",
            "#{client_pid} #{client_width} #{client_height}",
        ],
        Query::PaneDead => vec!["display-message", "-p", "-t", "office", "#{pane_dead}"],
        Query::Environment(_) => unreachable!("closed environment branch"),
    };
    let args = reverie_contracts::worker_launch::tmux_exec_args(
        &ContainerReference::Observed(cid),
        &command
            .into_iter()
            .map(MetadataText::from_scalar_text)
            .collect::<Vec<_>>(),
        false,
    );
    super::super::super::network::encode_arguments(&args)
}
