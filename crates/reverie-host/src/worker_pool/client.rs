//! One installed native controller connection transferred from the ORIGINAL
//! bootstrap. The App must retain actual consent and provider maintenance;
//! protocol/metadata DATA alone never authorizes this producer.
use super::*;
use crate::{
    captured_client::{CapturedCall, Policy},
    engine_metadata::{EngineQuery, MetadataQueryOwner},
    native,
    worker_runtime::WorkerRuntime,
};
use reverie_core::ids::ContainerId;
use serde::Serialize;
use std::{
    ffi::OsString,
    fs::File,
    io::Write,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::{fs::MetadataExt, net::UnixStream},
    },
    time::{Duration, Instant},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerStatusData {
    pub active: bool,
    pub controller_id: Option<String>,
    pub anchor_id: Option<String>,
    pub policy_sha256: String,
}
/// Owns actual origin/client and opened physical parent, not a JSON grant.
pub struct ActivatedController {
    owner: Option<Box<ControllerState>>,
}
struct ControllerState {
    binding: BrokerBootstrapBinding,
    publication: ControllerBirthPublication,
    policy: WorkerPoolPolicy,
    digest: [u8; 32],
    query: MetadataQueryOwner,
    pending: Option<CapturedCall>,
    raw_create: Option<Vec<u8>>,
    controller: Option<ContainerId>,
    client: Option<UnixStream>,
    pidfd: Option<OwnedFd>,
    directory: PoolDirectory,
    anchor: Option<String>,
    anchor_pid: u32,
    active: bool,
    attempted: bool,
    effect_unknown: bool,
    close_unknown: bool,
    stop_attempted: bool,
    cleanup_end: Option<Instant>,
    original_end: Instant,
}
pub struct ControllerActivationFailure {
    owner: ActivatedController,
    primary: PoolError,
}
impl BrokerBootstrapBinding {
    pub fn activate_controller(
        self,
        publication: ControllerBirthPublication,
        runtime: &WorkerRuntime,
        host_reserve_mib: u32,
        end: Instant,
    ) -> std::result::Result<ActivatedController, Box<ControllerActivationFailure>> {
        let policy = publication.birth_data().policy().clone();
        let query = runtime.installed_engine().readonly().capture_query_owner();
        let mut owner = ControllerState {
            binding: self,
            publication,
            policy: policy.clone(),
            digest: [0; 32],
            query,
            pending: None,
            raw_create: None,
            controller: None,
            client: None,
            pidfd: None,
            directory: PoolDirectory::unopened(&policy),
            anchor: None,
            anchor_pid: 0,
            active: false,
            attempted: false,
            effect_unknown: false,
            close_unknown: false,
            stop_attempted: false,
            cleanup_end: None,
            original_end: end.min(Instant::now() + Duration::from_secs(20)),
        };
        match owner.activate(runtime, host_reserve_mib) {
            Ok(()) => Ok(ActivatedController {
                owner: Some(Box::new(owner)),
            }),
            Err(primary) => {
                owner.close_unknown |= primary.close_unknown();
                Err(Box::new(ControllerActivationFailure {
                    owner: ActivatedController {
                        owner: Some(Box::new(owner)),
                    },
                    primary,
                }))
            }
        }
    }
}
impl ActivatedController {
    fn state(&self) -> &ControllerState {
        self.owner.as_ref().expect("original controller state")
    }
    fn state_mut(&mut self) -> &mut ControllerState {
        self.owner.as_mut().expect("original controller state")
    }
    pub fn policy_data(&self) -> &WorkerPoolPolicy {
        self.state().policy_data()
    }
    pub fn status_data(&self) -> ControllerStatusData {
        self.state().status_data()
    }
    pub fn assert_current(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        self.state_mut().assert_current(runtime, end)
    }
    pub fn close_components(&mut self, end: Instant) -> Result<()> {
        self.state_mut().close_components(end)
    }
    pub(crate) fn configure_target(
        &mut self,
        runtime: &WorkerRuntime,
        target: &crate::worker_laptop::CreatedPoolTarget<'_>,
        end: Instant,
    ) -> Result<member::MemberObservation> {
        self.state_mut().configure_target(runtime, target, end)
    }
}
impl ControllerState {
    pub fn policy_data(&self) -> &WorkerPoolPolicy {
        &self.policy
    }
    pub fn status_data(&self) -> ControllerStatusData {
        ControllerStatusData {
            active: self.active,
            controller_id: self.controller.as_ref().map(|id| id.as_str().into()),
            anchor_id: self.anchor.clone(),
            policy_sha256: hex(self.digest),
        }
    }
    fn activate(&mut self, runtime: &WorkerRuntime, reserve: u32) -> Result<()> {
        self.binding.assert_current(runtime, self.original_end)?;
        self.digest = self.publication.reference_data()?.digest();
        prepare_control_directory(&self.policy)?;
        self.publication.assert_current()?;
        let args = controller_arguments(&self.policy, self.digest)?;
        self.attempted = true;
        self.effect_unknown = true;
        self.raw_create = Some(self.call(runtime, args)?);
        let id = std::str::from_utf8(self.raw_create.as_ref().expect("raw create retained"))
            .ok()
            .map(|text| text.strip_suffix('\n').unwrap_or(text))
            .and_then(|text| ContainerId::parse(text).ok())
            .ok_or(PoolError::Refused("WORKER_POOL_CONTROLLER_CREATE_REPLY"))?;
        self.controller = Some(id);
        self.effect_unknown = false;
        self.publication.assert_current()?;
        self.effect_unknown = true;
        self.call(
            runtime,
            vec![
                "start".into(),
                self.controller
                    .as_ref()
                    .expect("original CID")
                    .as_str()
                    .into(),
            ],
        )?;
        self.effect_unknown = false;
        let inspected = self.inspect_controller(runtime, self.original_end)?;
        self.connect(runtime, &inspected, self.original_end)?;
        self.publication.assert_current()?;
        self.effect_unknown = true;
        let reply = self.exchange(
            serde_json::json!({"verb":"activate","requestId":fresh_id()?,"hostReserveMiB":reserve}),
            self.original_end,
        )?;
        self.capture_parent(runtime, &reply, self.original_end)?;
        self.effect_unknown = false;
        self.publication.assert_current()?;
        self.publication.close()?;
        self.active = true;
        self.assert_current(runtime, self.original_end)
    }
    fn call(&mut self, runtime: &WorkerRuntime, args: Vec<OsString>) -> Result<Vec<u8>> {
        need(
            self.pending.is_none(),
            "WORKER_POOL_CONTROLLER_CALL_RETAINED",
        )?;
        let end = runtime
            .stop_deadline()
            .map_or(self.original_end, |stop| stop.min(self.original_end));
        match runtime.installed_engine().engine.client.run_scoped(
            args,
            end,
            &runtime.cancellation(),
            Policy {
                maximum: Duration::from_secs(20),
                maximum_output: 4 * 1024 * 1024,
                successful_exit: true,
            },
        ) {
            Ok(output) => Ok(output.stdout),
            Err(failure) => {
                self.pending = failure.call;
                Err(PoolError::Engine(
                    crate::engine_metadata::EngineError::from(failure.error),
                ))
            }
        }
    }
    fn inspect_controller(
        &self,
        runtime: &WorkerRuntime,
        end: Instant,
    ) -> Result<serde_json::Value> {
        self.query
            .assert_engine(&runtime.installed_engine().readonly())
            .map_err(PoolError::Engine)?;
        let id = self
            .controller
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_CONTROLLER_UNKNOWN"))?;
        let raw = self
            .query
            .query(
                EngineQuery::WorkerPoolInspect(id),
                end,
                &runtime.cancellation(),
            )
            .map_err(PoolError::Engine)?;
        let values: Vec<serde_json::Value> = serde_json::from_str(&raw)
            .map_err(|_| PoolError::Refused("WORKER_POOL_CONTROLLER_INSPECTION"))?;
        need(values.len() == 1, "WORKER_POOL_CONTROLLER_INSPECTION")?;
        let value = values.into_iter().next().expect("one actual inspected CID");
        let pid = value["State"]["Pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .ok_or(PoolError::Refused("WORKER_POOL_CONTROLLER_PID"))?;
        reverie_contracts::worker_pool::validate_controller_service_v2_inspection(
            &serde_json::to_vec(&value)
                .map_err(|_| PoolError::Refused("WORKER_POOL_CONTROLLER_INSPECTION"))?,
            &self.policy,
            id.as_str(),
            pid,
            &hex(self.digest),
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_CONTROLLER_INSPECTION"))?;
        Ok(value)
    }
    fn connect(
        &mut self,
        runtime: &WorkerRuntime,
        inspected: &serde_json::Value,
        end: Instant,
    ) -> Result<()> {
        let path = std::path::Path::new(&self.policy.instance_root)
            .join("worker-pool/control/controller.sock");
        let address = nix::sys::socket::UnixAddr::new(&path).map_err(std::io::Error::from)?;
        loop {
            need(
                Instant::now() < end,
                "WORKER_POOL_CONTROLLER_CONNECT_DEADLINE",
            )?;
            let fd = nix::sys::socket::socket(
                nix::sys::socket::AddressFamily::Unix,
                nix::sys::socket::SockType::Stream,
                nix::sys::socket::SockFlag::SOCK_NONBLOCK
                    | nix::sys::socket::SockFlag::SOCK_CLOEXEC,
                None,
            )
            .map_err(std::io::Error::from)?;
            self.client = Some(UnixStream::from(fd));
            let socket = self.client.as_ref().expect("stored before connect");
            match nix::sys::socket::connect(socket.as_raw_fd(), &address) {
                Ok(()) => break,
                Err(nix::errno::Errno::EINPROGRESS) => {
                    use std::os::fd::AsFd;
                    loop {
                        need(
                            Instant::now() < end,
                            "WORKER_POOL_CONTROLLER_CONNECT_DEADLINE",
                        )?;
                        let mut ready = [nix::poll::PollFd::new(
                            socket.as_fd(),
                            nix::poll::PollFlags::POLLOUT,
                        )];
                        if nix::poll::poll(&mut ready, 10u16).map_err(std::io::Error::from)? > 0 {
                            let error = nix::sys::socket::getsockopt(
                                socket,
                                nix::sys::socket::sockopt::SocketError,
                            )
                            .map_err(std::io::Error::from)?;
                            if error != 0 {
                                return Err(std::io::Error::from_raw_os_error(error).into());
                            }
                            break;
                        }
                    }
                    break;
                }
                Err(nix::errno::Errno::ENOENT) => {
                    let socket = self.client.take().expect("original failed connect");
                    if let Err(error) = native::close(File::from(OwnedFd::from(socket))) {
                        self.close_unknown = true;
                        return Err(PoolError::MetadataClose(Box::new(error.into())));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(std::io::Error::from(error).into()),
            }
        }
        let metadata = std::fs::symlink_metadata(&path)?;
        use std::os::unix::fs::FileTypeExt;
        need(
            metadata.file_type().is_socket()
                && metadata.uid() == 0
                && metadata.gid() == self.policy.broker_gid
                && metadata.mode() & 0o7777 == 0o660,
            "WORKER_POOL_CONTROLLER_SOCKET_CUSTODY",
        )?;
        let stream = self.client.as_ref().expect("actual client retained");
        stream.set_nonblocking(true)?;
        nix::sys::socket::setsockopt(stream, nix::sys::socket::sockopt::PassCred, &true)
            .map_err(std::io::Error::from)?;
        self.pidfd = Some(
            nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerPidfd)
                .map_err(std::io::Error::from)?,
        );
        self.verify_peer(inspected)?;
        self.binding.assert_current(runtime, end)
    }
    fn verify_peer(&self, inspected: &serde_json::Value) -> Result<()> {
        use std::os::fd::AsFd;
        let stream = self
            .client
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_CONTROLLER_CHANNEL"))?;
        let peer = nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials)
            .map_err(std::io::Error::from)?;
        need(
            peer.uid() == 0
                && peer.gid() == self.policy.broker_gid
                && Some(peer.pid() as u64) == inspected["State"]["Pid"].as_u64(),
            "WORKER_POOL_CONTROLLER_PEER",
        )?;
        let pidfd = self
            .pidfd
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_CONTROLLER_PIDFD"))?;
        let mut ready = [nix::poll::PollFd::new(
            pidfd.as_fd(),
            nix::poll::PollFlags::POLLIN,
        )];
        need(
            nix::poll::poll(&mut ready, nix::poll::PollTimeout::ZERO)
                .map_err(std::io::Error::from)?
                == 0,
            "WORKER_POOL_CONTROLLER_ENDED",
        )
    }
    fn capture_parent(
        &mut self,
        runtime: &WorkerRuntime,
        reply: &serde_json::Value,
        end: Instant,
    ) -> Result<()> {
        need(
            reply["known"] == true && reply["phase"] == "active",
            "WORKER_POOL_ACTIVATION_UNCONFIRMED",
        )?;
        let id = reply["anchor"]["container"]
            .as_str()
            .filter(|id| reverie_contracts::worker_pool::hex_id(id))
            .ok_or(PoolError::Refused("WORKER_POOL_ANCHOR_REPLY"))?
            .to_owned();
        let cid =
            ContainerId::parse(&id).map_err(|_| PoolError::Refused("WORKER_POOL_ANCHOR_REPLY"))?;
        let raw = self
            .query
            .query(
                EngineQuery::WorkerPoolInspect(&cid),
                end,
                &runtime.cancellation(),
            )
            .map_err(PoolError::Engine)?;
        let values: Vec<serde_json::Value> = serde_json::from_str(&raw)
            .map_err(|_| PoolError::Refused("WORKER_POOL_ANCHOR_REPLY"))?;
        need(values.len() == 1, "WORKER_POOL_ANCHOR_REPLY")?;
        let pid = values[0]["State"]["Pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .ok_or(PoolError::Refused("WORKER_POOL_ANCHOR_PID"))?;
        reverie_contracts::worker_pool::validate_anchor_inspection(
            &serde_json::to_vec(&values[0])
                .map_err(|_| PoolError::Refused("WORKER_POOL_ANCHOR_REPLY"))?,
            &self.policy,
            &id,
            pid,
            &hex(self.digest),
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_ANCHOR_REPLY"))?;
        self.anchor = Some(id);
        self.anchor_pid = pid;
        self.directory.acquire(
            &self.policy,
            self.anchor.as_deref().expect("actual observed anchor"),
            pid,
        )?;
        self.directory.assert_limits(&self.policy)
    }
    pub fn assert_current(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        need(
            self.active && !self.close_unknown && !self.effect_unknown,
            "WORKER_POOL_CONTROLLER_NOT_ACTIVE",
        )?;
        self.binding.assert_current(runtime, end)?;
        self.verify_peer(&self.inspect_controller(runtime, end)?)?;
        self.directory.assert_anchor_current(
            self.anchor.as_deref().expect("active original anchor"),
            self.anchor_pid,
        )?;
        self.directory.assert_limits(&self.policy)
    }
    pub fn close_components(&mut self, end: Instant) -> Result<()> {
        self.active = false;
        let end = *self.cleanup_end.get_or_insert_with(|| {
            self.binding
                .stop
                .deadline()
                .map_or(end, |stop| stop.min(end))
        });
        let query = self.query.settle_owned(end).map_err(PoolError::Engine);
        let pending = self.pending.as_ref().map_or(Ok(()), |call| {
            self.binding
                .engine
                .engine
                .client
                .settle_call(call, end)
                .map_err(|error| {
                    PoolError::Engine(crate::engine_metadata::EngineError::from(error))
                })
        });
        if pending.is_ok() {
            self.pending = None;
        }
        let stopped = if query.is_ok() && pending.is_ok() {
            self.stop_controller(end)
        } else {
            Err(PoolError::Refused("WORKER_POOL_CONTROLLER_CALL_RETAINED"))
        };
        let stream = self
            .client
            .take()
            .map(|socket| native::close(File::from(OwnedFd::from(socket))))
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let pidfd = self
            .pidfd
            .take()
            .map(|fd| native::close(File::from(fd)))
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        self.close_unknown |= stream.is_err() || pidfd.is_err();
        let closed = finalized(
            stopped,
            finalized(
                finalized(finalized(stream, pidfd), finalized(query, pending)),
                finalized(
                    self.directory.close(),
                    finalized(self.publication.close(), self.binding.close()),
                ),
            ),
        );
        closed?;
        need(
            !self.close_unknown && !self.effect_unknown,
            "WORKER_POOL_CONTROLLER_EFFECT_UNCONFIRMED",
        )
    }
    fn stop_controller(&mut self, end: Instant) -> Result<()> {
        let Some(id) = &self.controller else {
            return need(
                !self.effect_unknown,
                "WORKER_POOL_CONTROLLER_CREATE_UNCONFIRMED",
            );
        };
        if self.stop_attempted {
            return need(
                !self.effect_unknown,
                "WORKER_POOL_CONTROLLER_STOP_UNCONFIRMED",
            );
        }
        need(
            self.pending.is_none(),
            "WORKER_POOL_CONTROLLER_CALL_RETAINED",
        )?;
        self.stop_attempted = true;
        // Dedicated component only: never a worker C stop. A fresh cancellation
        // token permits original cleanup, bounded by the SAME first stop.
        let end = self
            .binding
            .stop
            .deadline()
            .map_or(end, |stop| stop.min(end));
        let prior_unknown = self.effect_unknown;
        self.effect_unknown = true;
        match self.binding.engine.engine.client.run_scoped(
            vec![
                "stop".into(),
                "--time".into(),
                "1".into(),
                id.as_str().into(),
            ],
            end,
            &crate::engine_metadata::CancellationToken::new(),
            Policy {
                maximum: Duration::from_secs(3),
                maximum_output: 1_048_576,
                successful_exit: true,
            },
        ) {
            Ok(_) => {
                self.effect_unknown = prior_unknown;
                Ok(())
            }
            Err(failure) => {
                self.pending = failure.call;
                Err(PoolError::Engine(
                    crate::engine_metadata::EngineError::from(failure.error),
                ))
            }
        }
    }
}
impl ControllerActivationFailure {
    pub fn primary_error(&self) -> &PoolError {
        &self.primary
    }
    pub fn close_components(&mut self, end: Instant) -> Result<()> {
        self.owner.close_components(end)
    }
}
impl Drop for ActivatedController {
    fn drop(&mut self) {
        // The whole original attempt includes daemon facts, query/call owners,
        // bootstrap and publication, not just its currently open descriptors.
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
fn hex(value: [u8; 32]) -> String {
    value.iter().map(|b| format!("{b:02x}")).collect()
}
fn fresh_id() -> Result<String> {
    crate::resource_facts::fresh_owner_nonce()
        .map(|id| id.as_str().into())
        .map_err(|_| PoolError::Refused("WORKER_POOL_RANDOM"))
}
mod io;
mod member;
mod setup;
use setup::{controller_arguments, prepare_control_directory};
