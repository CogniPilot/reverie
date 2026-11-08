use super::*;
impl ControllerState {
    pub(super) fn exchange(
        &mut self,
        command: serde_json::Value,
        end: Instant,
    ) -> Result<serde_json::Value> {
        let id = command["requestId"]
            .as_str()
            .ok_or(PoolError::Refused("WORKER_POOL_REQUEST"))?
            .to_owned();
        let clock = crate::worker_pool::service::protocol::monotonic_ns()?;
        let remaining = end
            .saturating_duration_since(Instant::now())
            .as_nanos()
            .min(20_000_000_000) as u64;
        let raw=serde_json::to_vec(&serde_json::json!({"version":1,"purpose":"reverie-worker-pool-control-v1","deadlineMonotonicNs":clock.saturating_add(remaining),"request":command})).map_err(|_|PoolError::Refused("WORKER_POOL_REQUEST"))?;
        need(raw.len() <= 8192, "WORKER_POOL_REQUEST_BOUND")?;
        let mut bytes = (raw.len() as u32).to_be_bytes().to_vec();
        bytes.extend(raw);
        let socket = self
            .client
            .as_mut()
            .ok_or(PoolError::Refused("WORKER_POOL_CHANNEL"))?;
        let mut written = 0;
        while written < bytes.len() {
            need(Instant::now() < end, "WORKER_POOL_MESSAGE_DEADLINE")?;
            match socket.write(&bytes[written..]) {
                Ok(0) => return Err(PoolError::Refused("WORKER_POOL_CHANNEL_ENDED")),
                Ok(count) => written += count,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(1))
                }
                Err(error) => return Err(error.into()),
            }
        }
        let prefix = read_exact(socket, 4, end, &mut self.close_unknown)?;
        let count = u32::from_be_bytes(prefix.try_into().expect("four bytes")) as usize;
        need((1..=8192).contains(&count), "WORKER_POOL_REPLY_BOUND")?;
        let raw = read_exact(socket, count, end, &mut self.close_unknown)?;
        let value: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|_| PoolError::Refused("WORKER_POOL_REPLY"))?;
        need(
            value["version"] == 1 && value["requestId"] == id,
            "WORKER_POOL_REPLY_CORRELATION",
        )?;
        Ok(value)
    }
}
fn read_exact(
    socket: &mut UnixStream,
    count: usize,
    end: Instant,
    unknown: &mut bool,
) -> Result<Vec<u8>> {
    let mut bytes = vec![0; count];
    let mut read = 0;
    let peer = nix::sys::socket::getsockopt(socket, nix::sys::socket::sockopt::PeerCredentials)
        .map_err(std::io::Error::from)?;
    let expected = (peer.pid(), peer.uid(), peer.gid());
    while read < count {
        need(Instant::now() < end, "WORKER_POOL_MESSAGE_DEADLINE")?;
        match native::owned_process::receive_credentials(socket, &mut bytes[read..], expected) {
            Ok(0) => return Err(PoolError::Refused("WORKER_POOL_CHANNEL_ENDED")),
            Ok(count) => read += count,
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
    Ok(bytes)
}
