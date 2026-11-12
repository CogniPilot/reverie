use super::*;
impl ControllerState {
    pub(super) fn exchange(
        &mut self,
        command: serde_json::Value,
        end: Instant,
    ) -> Result<serde_json::Value> {
        // One component ceiling shared by the wire and native loops. Repeated
        // readiness waits cannot renew it or outlive the SAME first stop.
        let end = end.min(Instant::now() + Duration::from_secs(20));
        let end = self
            .binding
            .stop
            .deadline()
            .map_or(end, |stop| end.min(stop));
        let stop = &self.binding.stop;
        let id = command["requestId"]
            .as_str()
            .ok_or(PoolError::Refused("WORKER_POOL_REQUEST"))?
            .to_owned();
        let bytes = encode_request(command, end)?;
        let socket = self
            .client
            .as_mut()
            .ok_or(PoolError::Refused("WORKER_POOL_CHANNEL"))?;
        let mut written = 0;
        while written < bytes.len() {
            message_current(stop, end)?;
            match socket.write(&bytes[written..]) {
                Ok(0) => return Err(PoolError::Refused("WORKER_POOL_CHANNEL_ENDED")),
                Ok(count) => written += count,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(1))
                }
                Err(error) => return Err(error.into()),
            }
        }
        let prefix = read_exact(socket, 4, end, stop, &mut self.close_unknown)?;
        let count = u32::from_be_bytes(prefix.try_into().expect("four bytes")) as usize;
        need((1..=8192).contains(&count), "WORKER_POOL_REPLY_BOUND")?;
        let raw = read_exact(socket, count, end, stop, &mut self.close_unknown)?;
        let value: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|_| PoolError::Refused("WORKER_POOL_REPLY"))?;
        need(
            value["version"] == 1 && value["requestId"] == id,
            "WORKER_POOL_REPLY_CORRELATION",
        )?;
        Ok(value)
    }
}
fn encode_request(command: serde_json::Value, end: Instant) -> Result<Vec<u8>> {
    let clock = crate::worker_pool::service::protocol::monotonic_ns()?;
    let remaining = end
        .saturating_duration_since(Instant::now())
        .as_nanos()
        .min(20_000_000_000) as u64;
    let raw=serde_json::to_vec(&serde_json::json!({"version":1,"purpose":"reverie-worker-pool-control-v1","deadlineMonotonicNs":clock.saturating_add(remaining),"request":command})).map_err(|_|PoolError::Refused("WORKER_POOL_REQUEST"))?;
    need(raw.len() <= 8192, "WORKER_POOL_REQUEST_BOUND")?;
    let mut bytes = (raw.len() as u32).to_be_bytes().to_vec();
    bytes.extend(raw);
    Ok(bytes)
}

/// Progress belongs to the same original socket. Settlement only reads an
/// already transmitted frame. It never retransmits a command or reconnects.
pub(super) struct MemberPolicyWire {
    request_id: String,
    bytes: Vec<u8>,
    sent: usize,
    prefix: [u8; 4],
    prefix_read: usize,
    reply: Vec<u8>,
    reply_read: usize,
    write_started: bool,
}

impl MemberPolicyWire {
    pub(super) fn prepare(
        command: serde_json::Value,
        request_id: String,
        end: Instant,
    ) -> Result<Self> {
        Ok(Self {
            request_id,
            bytes: encode_request(command, end)?,
            sent: 0,
            prefix: [0; 4],
            prefix_read: 0,
            reply: Vec::new(),
            reply_read: 0,
            write_started: false,
        })
    }

    pub(super) fn transmit(
        &mut self,
        socket: &mut UnixStream,
        end: Instant,
        stop: &crate::worker_runtime::WorkerStopBudget,
    ) -> Result<()> {
        need(!self.write_started, "WORKER_POOL_MEMBER_EDIT_ALREADY_SENT")?;
        self.write_started = true;
        while self.sent < self.bytes.len() {
            message_current(stop, end)?;
            match socket.write(&self.bytes[self.sent..]) {
                Ok(0) => return Err(PoolError::Refused("WORKER_POOL_CHANNEL_ENDED")),
                Ok(count) => self.sent += count,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(1))
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    pub(super) fn receive(
        &mut self,
        socket: &mut UnixStream,
        end: Instant,
        stop: &crate::worker_runtime::WorkerStopBudget,
        unknown: &mut bool,
    ) -> Result<serde_json::Value> {
        need(
            self.write_started && self.sent == self.bytes.len(),
            "WORKER_POOL_MEMBER_EDIT_FRAME_INCOMPLETE",
        )?;
        read_into(
            socket,
            &mut self.prefix,
            &mut self.prefix_read,
            end,
            stop,
            unknown,
        )?;
        let count = u32::from_be_bytes(self.prefix) as usize;
        need((1..=8192).contains(&count), "WORKER_POOL_REPLY_BOUND")?;
        self.reply.resize(count, 0);
        read_into(
            socket,
            &mut self.reply,
            &mut self.reply_read,
            end,
            stop,
            unknown,
        )?;
        let value: serde_json::Value = serde_json::from_slice(&self.reply)
            .map_err(|_| PoolError::Refused("WORKER_POOL_REPLY"))?;
        need(
            value["version"] == 1 && value["requestId"] == self.request_id,
            "WORKER_POOL_REPLY_CORRELATION",
        )?;
        Ok(value)
    }
}

fn read_exact(
    socket: &mut UnixStream,
    count: usize,
    end: Instant,
    stop: &crate::worker_runtime::WorkerStopBudget,
    unknown: &mut bool,
) -> Result<Vec<u8>> {
    let mut bytes = vec![0; count];
    let mut read = 0;
    read_into(socket, &mut bytes, &mut read, end, stop, unknown)?;
    Ok(bytes)
}
fn read_into(
    socket: &mut UnixStream,
    bytes: &mut [u8],
    read: &mut usize,
    end: Instant,
    stop: &crate::worker_runtime::WorkerStopBudget,
    unknown: &mut bool,
) -> Result<()> {
    let peer = nix::sys::socket::getsockopt(socket, nix::sys::socket::sockopt::PeerCredentials)
        .map_err(std::io::Error::from)?;
    let expected = (peer.pid(), peer.uid(), peer.gid());
    while *read < bytes.len() {
        message_current(stop, end)?;
        match native::owned_process::receive_credentials(socket, &mut bytes[*read..], expected) {
            Ok(0) => return Err(PoolError::Refused("WORKER_POOL_CHANNEL_ENDED")),
            Ok(count) => *read += count,
            Err(error) if error.close_failed => {
                *unknown = true;
                return Err(PoolError::MetadataClose(Box::new(error.cause.into())));
            }
            Err(error) if error.cause.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(1))
            }
            Err(error) => return Err(error.cause.into()),
        }
    }
    Ok(())
}
fn message_current(stop: &crate::worker_runtime::WorkerStopBudget, end: Instant) -> Result<()> {
    let end = stop.deadline().map_or(end, |stop| end.min(stop));
    need(Instant::now() < end, "WORKER_POOL_MESSAGE_DEADLINE")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine};
    use nix::sys::socket::{setsockopt, sockopt};
    use reverie_core::{
        resources::{BudgetMode, CpuQuota, ResourcePolicy},
        worker_schema::{WorkerBase, WorkerIds},
    };
    use std::{collections::BTreeMap, io::Read};

    fn runtime() -> WorkerRuntime {
        let executable = std::env::current_exe().unwrap();
        let bootstrap = EngineBootstrap::from_service(
            executable.as_os_str(),
            BTreeMap::new(),
            std::env::current_dir().unwrap(),
        )
        .unwrap();
        let base = WorkerBase::try_new(
            "fixture".into(),
            "fixture-server".into(),
            format!("sha256:{}", "a".repeat(64)),
            WorkerIds::try_new(1000, 1000).unwrap(),
            4,
            ResourcePolicy::try_new(
                BudgetMode::Admission,
                1024,
                128,
                CpuQuota::from_integer(1).unwrap(),
                8192,
                512,
            )
            .unwrap(),
        )
        .unwrap();
        WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), &base)
    }

    const REQUEST: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    #[test]
    fn partial_member_policy_command_stays_retained_without_retransmission() {
        let runtime = runtime();
        let stop = runtime.stop_budget();
        let (mut sender, mut peer) = UnixStream::pair().unwrap();
        sender.set_nonblocking(true).unwrap();
        peer.set_nonblocking(true).unwrap();
        setsockopt(&sender, sockopt::SndBuf, &1024).unwrap();
        let end = Instant::now() + Duration::from_millis(200);
        let mut wire = MemberPolicyWire::prepare(
            serde_json::json!({"verb":"applyMemberPolicy","requestId":REQUEST,"padding":"x".repeat(7000)}),
            REQUEST.into(), end,
        ).unwrap();
        let failed = wire.transmit(&mut sender, end, &stop).unwrap_err();
        let end = Instant::now() + Duration::from_secs(2);
        let mut bytes = vec![0; wire.bytes.len()];
        let received = peer.read(&mut bytes).unwrap();
        let repeated = wire.transmit(&mut sender, end, &stop).unwrap_err();
        let unconfirmed = wire
            .receive(&mut sender, end, &stop, &mut false)
            .unwrap_err();
        let remaining = peer.read(&mut [0; 1]).unwrap_err();
        native::close(File::from(OwnedFd::from(sender))).unwrap();
        native::close(File::from(OwnedFd::from(peer))).unwrap();
        runtime.close(end).unwrap();
        assert!(received > 0 && received < wire.bytes.len());
        assert_eq!(received, wire.sent);
        assert_eq!(bytes[..received], wire.bytes[..received]);
        assert_eq!(failed.code(), "WORKER_POOL_MESSAGE_DEADLINE");
        assert_eq!(repeated.code(), "WORKER_POOL_MEMBER_EDIT_ALREADY_SENT");
        assert_eq!(
            unconfirmed.code(),
            "WORKER_POOL_MEMBER_EDIT_FRAME_INCOMPLETE"
        );
        assert_eq!(remaining.kind(), std::io::ErrorKind::WouldBlock);
    }

    #[test]
    fn original_member_policy_reply_resumes_after_partial_authenticated_prefix() {
        let runtime = runtime();
        let stop = runtime.stop_budget();
        let (mut sender, mut peer) = UnixStream::pair().unwrap();
        sender.set_nonblocking(true).unwrap();
        setsockopt(&sender, sockopt::PassCred, &true).unwrap();
        let end = Instant::now() + Duration::from_secs(2);
        let mut wire = MemberPolicyWire::prepare(
            serde_json::json!({"verb":"commitMemberPolicy","requestId":REQUEST}),
            REQUEST.into(),
            end,
        )
        .unwrap();
        wire.transmit(&mut sender, end, &stop).unwrap();
        let mut command = vec![0; wire.bytes.len()];
        peer.read_exact(&mut command).unwrap();
        let raw = serde_json::to_vec(&serde_json::json!({
            "version":1, "requestId":REQUEST, "phase":"memberPolicyCommitted", "known":true
        }))
        .unwrap();
        let prefix = (raw.len() as u32).to_be_bytes();
        peer.write_all(&prefix[..2]).unwrap();
        let mut unknown = false;
        let failure = wire
            .receive(
                &mut sender,
                Instant::now() + Duration::from_millis(100),
                &stop,
                &mut unknown,
            )
            .unwrap_err();
        let original_progress = wire.prefix_read;
        peer.write_all(&prefix[2..]).unwrap();
        peer.write_all(&raw).unwrap();
        let reply = wire.receive(&mut sender, end, &stop, &mut unknown).unwrap();
        peer.set_nonblocking(true).unwrap();
        let no_replay = peer.read(&mut [0; 1]).unwrap_err();
        native::close(File::from(OwnedFd::from(sender))).unwrap();
        native::close(File::from(OwnedFd::from(peer))).unwrap();
        runtime.close(end).unwrap();
        assert_eq!(failure.code(), "WORKER_POOL_MESSAGE_DEADLINE");
        assert_eq!(original_progress, 2);
        assert_eq!(reply["phase"], "memberPolicyCommitted");
        assert_eq!(command, wire.bytes);
        assert!(!unknown);
        assert_eq!(no_replay.kind(), std::io::ErrorKind::WouldBlock);
    }
}
