use super::*;
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
use std::{collections::BTreeMap, os::unix::fs::DirBuilderExt};
pub(super) struct Fixture {
    pub root: PathBuf,
    pub broker: InstallingBroker,
    pub temporary: PathBuf,
    mounted: bool,
    closed: bool,
}
impl Fixture {
    pub(super) fn new() -> Self {
        assert_eq!(std::process::id(), 1, "actual isolated fixture");
        let root = std::env::temp_dir().join("actor");
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        for path in ["work/attachments", "company/console"] {
            fs::create_dir_all(root.join(path)).unwrap();
        }
        let metadata = fs::metadata(&root).unwrap();
        let mut config: Json = serde_json::from_str(include_str!(
            "../../../../../reverie-contracts/tests/fixtures/broker-laptop-python.json"
        ))
        .unwrap();
        let source = &mut config["configuration"];
        for (key, path) in [
            ("companyFile", "company.json"),
            ("companyRoot", "company"),
            ("stateRoot", "state"),
            ("scratchRoot", "scratch"),
            ("apiSocketRoot", "office"),
            ("socket", "control/broker.sock"),
        ] {
            source[key] = json!(root.join(path));
        }
        source["uid"] = json!(metadata.uid());
        source["gid"] = json!(metadata.gid());
        source["mounts"] = json!([{"source":root.join("work"),"destination":"/reverie_workspace","readOnly":false}]);
        fs::write(root.join("company.json"),serde_json::to_vec(&json!({"employees":[{"id":EID,"sessionId":SID,"owner":null,"desiredRunning":true}]})).unwrap()).unwrap();
        fs::set_permissions(root.join("company.json"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(
            root.join("company/console/.env"),
            "REVERIE_USERNAME=fixture\nREVERIE_PASSWORD=synthetic-only\n",
        )
        .unwrap();
        fs::write(root.join("names.out"), format!("test-agent-{SID}\n")).unwrap();
        fs::write(root.join("ids.out"), "").unwrap();
        fs::write(root.join("server.out"),br#"[{"State":{"Running":true},"NetworkSettings":{"Networks":{"bridge":{"IPAddress":"127.0.0.1"}}}}]"#).unwrap();
        fs::write(
            root.join("engine.rs"),
            include_str!("../../../../tests/support/chat_image_child.rs"),
        )
        .unwrap();
        let program = root.join("engine");
        assert!(
            Command::new("rustc")
                .args(["--edition=2024", "-o"])
                .arg(&program)
                .arg(root.join("engine.rs"))
                .status()
                .unwrap()
                .success()
        );
        let config =
            reverie_contracts::worker_config::decode(&serde_json::to_vec(source).unwrap()).unwrap();
        let snapshot = crate::worker_validation::validate_captured(config).unwrap();
        let engine =
            EngineBootstrap::from_service(program.as_os_str(), BTreeMap::new(), root.clone())
                .unwrap();
        let runtime = WorkerRuntime::new(
            InstalledWorkerEngine::new(engine),
            snapshot.envelope().base(),
        );
        let broker = InstallingBroker::new(snapshot, runtime).unwrap();
        let sid = reverie_core::ids::ProfileSessionId::parse(SID).unwrap();
        let mut storage = reverie_host::worker_storage::StorageLease::acquire_launch(
            broker.configuration().unwrap().configuration(),
            &sid,
        )
        .unwrap();
        storage.prepare_storage().unwrap();
        storage.record_storage_binding().unwrap();
        let temporary = storage.paths().scratch().join("tmp");
        storage.close().unwrap();
        fs::create_dir_all(&temporary).unwrap();
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("inspect.out"),serde_json::to_vec(&json!([{"Id":"a".repeat(64),"Name":format!("/test-agent-{SID}"),"Image":format!("sha256:{}","b".repeat(64)),"State":{"Running":true,"Paused":false,"Restarting":false,"Dead":false,"Pid":std::process::id(),"StartedAt":"owned-start"},"Config":{"User":format!("{}:{}",metadata.uid(),metadata.gid()),"Labels":{"reverie.worker":"test","reverie.session":SID,"reverie.employee":EID}},"Mounts":[{"Type":"bind","Source":root.join("work"),"Destination":"/reverie_workspace","RW":true},{"Type":"tmpfs","Source":"","Destination":"/reverie_workspace/attachments","RW":false},{"Type":"bind","Source":temporary,"Destination":"/tmp","RW":true}]}])).unwrap()).unwrap();
        Self {
            root,
            broker,
            temporary,
            mounted: false,
            closed: false,
        }
    }
    pub(super) fn mount(&mut self) {
        namespace::mount_tmp(&self.temporary);
        self.mounted = true;
    }
    pub(super) fn recover(&self) {
        let recovered = self.broker.recover_laptops().unwrap();
        assert_eq!(recovered.registered(), 1);
    }
    pub(super) fn close(&mut self) {
        self.broker.close_chat_images(end()).unwrap();
        let offices = self
            .broker
            .installed
            .lifecycle()
            .unwrap()
            .guard
            .iter()
            .map(|entry| {
                let LaptopOwner::Recovered(owner) = &entry.owner else {
                    panic!("actual recovery")
                };
                owner.office._office.clone()
            })
            .collect::<Vec<_>>();
        for office in offices {
            office.close(end()).unwrap();
        }
        self.broker.reports.close(end()).unwrap();
        let mut life = self.broker.installed.lifecycle().unwrap();
        for entry in life.guard.drain(..) {
            let LaptopOwner::Recovered(owner) = entry.owner else {
                panic!("actual recovery")
            };
            owner.storage.release(end()).unwrap();
        }
        drop(life);
        self.broker.storage.runtime.close(end()).unwrap();
        if self.mounted {
            namespace::unmount_tmp();
            self.mounted = false;
        }
        self.closed = true;
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.closed {
            eprintln!(
                "owned synthetic M fixture preserved at {}",
                self.root.display()
            );
        }
    }
}
