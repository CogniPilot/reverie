//! Fixed engine-derived provider process observations. No public PID selector:
//! every PID comes from this same owner's fresh inspect/top response.
use super::*;
use crate::engine_metadata::{CancellationToken, EngineQuery, MetadataQueryOwner, ReadonlyEngine};
use reverie_contracts::{
    reservation_engine::{ContainerRow, InventoryDecoder},
    worker_provider_health::{ProviderPane, ProviderTopology, namespace_pid},
};

#[derive(Clone, Debug, Eq, PartialEq)]
struct Record {
    process: ProcessSnapshot,
    root: [u64; 2],
    guest: UnsignedInteger,
}
pub struct ProviderProcessObservation {
    init: ProcessSnapshot,
    pane_dead: bool,
    live_child: bool,
}
impl ProviderProcessObservation {
    pub fn init(&self) -> &ProcessSnapshot {
        &self.init
    }
    pub fn pane_dead(&self) -> bool {
        self.pane_dead
    }
    pub fn live_child(&self) -> bool {
        self.live_child
    }
}
impl WebsiteProcessObserver {
    pub fn observe_provider(
        &mut self,
        engine: &ReadonlyEngine,
        owner: &MetadataQueryOwner,
        row: &ContainerRow,
        end: Instant,
        cancellation: &CancellationToken,
    ) -> Result<ProviderProcessObservation> {
        self.current(end)?;
        owner
            .assert_engine(engine)
            .map_err(|e| WebsiteFactsError::Io(std::io::Error::other(e)))?;
        let query = |query| {
            owner
                .query(query, end, cancellation)
                .map_err(|e| WebsiteFactsError::Io(std::io::Error::other(e)))
        };
        // Re-read the actual engine record; a caller's row/PID cannot mint a proof.
        let raw = query(EngineQuery::InspectBatch(std::slice::from_ref(row.id())))?;
        let mut decoded = InventoryDecoder::new(std::slice::from_ref(row.id()))
            .map_err(|_| WebsiteFactsError::Refused("PROVIDER_ROW"))?;
        decoded
            .push(&raw)
            .map_err(|_| WebsiteFactsError::Refused("PROVIDER_ROW"))?;
        let rows = decoded
            .finish()
            .map_err(|_| WebsiteFactsError::Refused("PROVIDER_ROW"))?;
        need(rows.rows().len() == 1, "PROVIDER_ROW")?;
        let actual = &rows.rows()[0];
        let digest = |row: &ContainerRow| {
            row.snapshot_digest()
                .map_err(|_| WebsiteFactsError::Refused("PROVIDER_ROW"))
        };
        need(digest(actual)? == digest(row)?, "PROVIDER_ROW_CHANGED")?;
        actual
            .running_header()
            .map_err(|_| WebsiteFactsError::Refused("PROVIDER_ROW"))?;
        let state_raw = query(EngineQuery::InspectStopped(actual.id()))?;
        let state = provider_state(actual.id(), &state_raw)?;
        state
            .provider_running_header()
            .map_err(|_| WebsiteFactsError::Refused("PROVIDER_STATE"))?;
        need(
            state.pid().ok() == actual.pid().ok(),
            "PROVIDER_STATE_CHANGED",
        )?;
        let init = self.provider_record(
            &actual
                .pid()
                .map_err(|_| WebsiteFactsError::Refused("PROVIDER_PID"))?,
            end,
        )?;
        let pane = ProviderPane::decode(&query(EngineQuery::ProviderPane(actual.id()))?)
            .map_err(WebsiteFactsError::Refused)?;
        let live_child = if pane.dead() {
            false
        } else {
            let topology = ProviderTopology::decode(&query(EngineQuery::ProviderTop(actual.id()))?)
                .map_err(WebsiteFactsError::Refused)?;
            self.provider_children(&topology, &init, pane.guest_pid(), end)?
        };
        need(
            self.provider_record(init.process.pid(), end)? == init,
            "PROVIDER_INIT_CHANGED",
        )?;
        let final_state = provider_state(
            actual.id(),
            &query(EngineQuery::InspectStopped(actual.id()))?,
        )?;
        need(
            digest(&final_state)? == digest(&state)?,
            "PROVIDER_STATE_CHANGED",
        )?;
        Ok(ProviderProcessObservation {
            init: init.process,
            pane_dead: pane.dead(),
            live_child,
        })
    }
    fn provider_children(
        &mut self,
        topology: &ProviderTopology,
        init: &Record,
        pane: &UnsignedInteger,
        end: Instant,
    ) -> Result<bool> {
        let mut records = Vec::new();
        for (pid, parent) in topology.pairs() {
            let record = match self.provider_record(pid, end) {
                Ok(record) => record,
                Err(WebsiteFactsError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                    continue;
                }
                Err(error) => return Err(error),
            };
            if record.process.parent() == parent
                && record.root == init.root
                && record.process.namespaces() == init.process.namespaces()
            {
                records.push(record);
            }
        }
        let panes = records
            .iter()
            .filter(|record| &record.guest == pane)
            .collect::<Vec<_>>();
        need(panes.len() == 1, "PROVIDER_PANE_PROCESS")?;
        let child = records
            .iter()
            .any(|record| record.process.parent() == panes[0].process.pid());
        for record in &records {
            need(
                self.provider_record(record.process.pid(), end)? == *record,
                "PROVIDER_PROCESS_CHANGED",
            )?;
        }
        Ok(child)
    }
    fn provider_record(&mut self, pid: &UnsignedInteger, end: Instant) -> Result<Record> {
        self.current(end)?;
        let mut files = Descriptors::default();
        let body = (|| {
            let process = read::process(&mut files, pid, end)?;
            let raw = read::bytes(&mut files, pid, "status", 16384, end)?;
            let guest = namespace_pid(&raw, pid).map_err(WebsiteFactsError::Refused)?;
            let root = read::identity(&mut files, pid, "root", end)?;
            need(
                read::process(&mut files, pid, end)? == process,
                "PROVIDER_PROCESS_CHANGED",
            )?;
            Ok(Record {
                process,
                root,
                guest,
            })
        })();
        files.finish(body, &mut self.close_uncertain)
    }
}
fn provider_state(id: &reverie_core::ids::ContainerId, raw: &str) -> Result<ContainerRow> {
    let mut decoder = InventoryDecoder::new(std::slice::from_ref(id))
        .map_err(|_| WebsiteFactsError::Refused("PROVIDER_STATE"))?;
    decoder
        .push(raw)
        .map_err(|_| WebsiteFactsError::Refused("PROVIDER_STATE"))?;
    let rows = decoder
        .finish()
        .map_err(|_| WebsiteFactsError::Refused("PROVIDER_STATE"))?;
    need(rows.rows().len() == 1, "PROVIDER_STATE")?;
    Ok(rows.rows()[0].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owned_engine_response_selects_real_parent_and_live_native_child() {
        use std::{
            fs,
            os::{fd::OwnedFd, unix::fs::PermissionsExt},
        };
        let root = std::env::temp_dir().join(format!("provider-process-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = root.join("storage-writer");
        fs::hard_link(crate::engine_metadata::tests::program(), &executable).unwrap();
        let engine = ReadonlyEngine::new(
            crate::engine_metadata::EngineBootstrap::from_service(
                executable.as_os_str(),
                Default::default(),
                root.clone(),
            )
            .unwrap(),
        );
        let owner = engine.capture_query_owner();
        let mut observer = WebsiteProcessObserver::default();
        let mut child = super::super::tests::child(true);
        let output: OwnedFd = child.stdout.take().unwrap().into();
        let end = Instant::now() + std::time::Duration::from_secs(10);
        let body = (|| -> std::result::Result<ProviderProcessObservation, String> {
            super::super::tests::await_ready(&output, end)?;
            let id = reverie_core::ids::ContainerId::parse(&"a".repeat(64)).unwrap();
            let row=serde_json::json!({"Id":id.as_str(),"Name":"/owned-provider","Image":format!("sha256:{}","b".repeat(64)),"Config":{"Labels":{}},"State":{"Running":true,"Pid":std::process::id(),"Paused":false,"Restarting":false,"Dead":false},"Mounts":[],"HostConfig":{"Memory":0,"MemorySwap":0,"PidsLimit":0,"NanoCpus":0}}).to_string();
            fs::write(root.join("inspect.out"), &row).unwrap();
            fs::write(
                root.join("provider-pane.out"),
                format!("0|{}", std::process::id()),
            )
            .unwrap();
            let parent = std::fs::read_to_string("/proc/self/stat").unwrap();
            let parent = parent
                .rsplit_once(") ")
                .unwrap()
                .1
                .split_whitespace()
                .nth(1)
                .unwrap();
            fs::write(
                root.join("provider-top.out"),
                format!(
                    "PID PPID\n{} {parent}\n{} {}\n",
                    std::process::id(),
                    child.id(),
                    std::process::id()
                ),
            )
            .unwrap();
            let row = provider_state(&id, &row).unwrap();
            observer
                .observe_provider(&engine, &owner, &row, end, &CancellationToken::new())
                .map_err(|error| error.to_string())
        })();
        let settled = owner.settle_owned(end);
        let status = super::super::tests::finish(&mut child);
        let closed = crate::native::owned_process::close(output);
        let finalized = observer.assert_finalized();
        if settled.is_ok() && status.is_ok() && closed.is_ok() {
            fs::remove_dir_all(&root).unwrap();
        } else {
            std::mem::forget(child);
        }
        settled.unwrap();
        assert!(status.unwrap().success());
        closed.unwrap();
        finalized.unwrap();
        let observed = body.unwrap();
        assert!(!observed.pane_dead());
        assert!(observed.live_child());
        assert_eq!(
            observed.init().pid().to_u64(),
            Some(u64::from(std::process::id()))
        );
    }
    #[test]
    fn actual_self_record_has_host_namespace_pid_and_stable_root_identity() {
        let mut observer = WebsiteProcessObserver::default();
        let pid = UnsignedInteger::from_u64(u64::from(std::process::id()));
        let end = Instant::now() + std::time::Duration::from_secs(5);
        let first = observer.provider_record(&pid, end).unwrap();
        assert_eq!(first.guest, pid);
        assert_eq!(observer.provider_record(&pid, end).unwrap(), first);
        observer.assert_finalized().unwrap();
    }
    #[test]
    fn actual_provider_record_consumed_close_failure_is_sticky() {
        let mut observer = WebsiteProcessObserver::default();
        let pid = UnsignedInteger::from_u64(u64::from(std::process::id()));
        let end = Instant::now() + std::time::Duration::from_secs(5);
        crate::native::test_faults::set(None, true);
        let first = observer.provider_record(&pid, end);
        crate::native::test_faults::set(None, false);
        assert!(first.is_err());
        assert!(observer.assert_finalized().is_err());
        assert_eq!(
            observer.provider_record(&pid, end).err().unwrap().code(),
            "WEBSITE_PROCESS_CLOSE_UNCONFIRMED"
        );
    }
}
