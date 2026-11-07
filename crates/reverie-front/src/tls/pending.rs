//! Pending TLS tasks retain cap slots, byte leases and transport ownership until joined.
use super::{TlsBudget, handshake, scratch::SharedScratch};
use crate::network::Transport;
use reverie_contracts::route_frames_v2::Listener;
use rustls::ServerConfig;
use std::{collections::BTreeMap, io, net::SocketAddr, sync::Arc};
use tokio::{
    net::TcpStream,
    task::{AbortHandle, Id, JoinSet},
};

pub(crate) struct Accepted {
    pub listener: Listener,
    pub epoch: u64,
    pub peer: SocketAddr,
    pub local: SocketAddr,
    pub transport: Transport,
}
#[derive(Default)]
pub(crate) struct Pending {
    tasks: JoinSet<io::Result<Accepted>>,
    handles: BTreeMap<Id, (Listener, AbortHandle)>,
}
impl Pending {
    pub(crate) fn len(&self) -> usize {
        self.tasks.len()
    }
    pub(crate) fn start(
        &mut self,
        listener: Listener,
        epoch: u64,
        socket: TcpStream,
        config: Arc<ServerConfig>,
        budget: TlsBudget,
        scratch: Arc<SharedScratch>,
    ) -> io::Result<()> {
        let peer = socket.peer_addr()?;
        let local = socket.local_addr()?;
        let handle = self.tasks.spawn(async move {
            let transport = handshake(socket, config, budget, scratch).await?;
            Ok(Accepted {
                listener,
                epoch,
                peer,
                local,
                transport,
            })
        });
        self.handles.insert(handle.id(), (listener, handle));
        Ok(())
    }
    pub(crate) fn cancel(&self, listener: Listener) {
        for (kind, handle) in self.handles.values() {
            if *kind == listener {
                handle.abort();
            }
        }
    }
    pub(crate) async fn next(&mut self) -> Option<Accepted> {
        let result = self.tasks.join_next_with_id().await?;
        match result {
            Ok((id, result)) => {
                self.handles.remove(&id);
                result.ok()
            }
            Err(error) => {
                self.handles.remove(&error.id());
                None
            }
        }
    }
    pub(crate) async fn close(&mut self) {
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        self.handles.clear();
    }
}
