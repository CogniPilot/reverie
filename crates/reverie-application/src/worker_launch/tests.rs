use super::*;
use serde_json::json;
use std::{
    cell::RefCell,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "launch-order-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(root.join("work")).unwrap();
        fs::write(root.join("company.json"), b"{\"employees\":[]}").unwrap();
        Self(root)
    }
    fn captured(&self) -> ValidatedWorkerSnapshot {
        let info = fs::metadata(&self.0).unwrap();
        crate::worker_validation::validate_captured(reverie_contracts::worker_config::decode(&serde_json::to_vec(&json!({"version":1,"deployment":"demo","image":format!("sha256:{}","a".repeat(64)),"serverContainer":"demo","socket":"/run/launch-order.sock","stateRoot":self.0.join("state"),"companyFile":self.0.join("company.json"),"companyRoot":self.0.join("company"),"scratchRoot":self.0.join("scratch"),"apiSocketRoot":self.0.join("api"),"budgetMode":"pool","uid":info.uid(),"gid":info.gid(),"memoryMiB":0,"poolMemoryMiB":4096,"poolTasksMax":1024,"cgroupParent":"reverie-workers.slice","pidsLimit":128,"cpus":0,"maxWorkers":4,"mounts":[{"source":self.0.join("work"),"destination":"/workspace","readOnly":false}],"maintenanceSessions":[]})).unwrap()).unwrap()).unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
struct Observed {
    log: RefCell<Vec<&'static str>>,
    fail: usize,
}
impl Source for Observed {
    fn rootless(&self, config: &RootlessConfig) -> Result<rootless::RootlessObservation> {
        self.log.borrow_mut().push("rootless");
        if self.log.borrow().len() == self.fail {
            return Err(LaunchPreparationError::Rootless(
                rootless::RootlessHostError::OwnerMismatch,
            ));
        }
        Ok(rootless::observe_rootless(config)?)
    }
    fn gpu(
        &self,
        config: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<Vec<String>> {
        self.log.borrow_mut().push("gpu");
        gpu_arguments(config, session)
    }
    fn hostname(
        &self,
        config: &EffectiveWorkerConfig,
        storage: &StoragePaths,
    ) -> Result<Option<String>> {
        self.log.borrow_mut().push("hostname");
        Ok(host::employee_hostname(config, storage)?)
    }
}
#[test]
fn security_and_runtime_are_separate_fresh_observations_and_fail_before_late_metadata() {
    let tree = Tree::new();
    let captured = tree.captured();
    let sid = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    let identity = worker_identity::storage_identity(
        &ResourceConfiguration::capture(captured.configuration().clone())
            .unwrap()
            .identity_settings()
            .unwrap(),
    )
    .unwrap();
    let paths = reverie_store::storage_identity::storage_paths(&identity, &sid).unwrap();
    for fail in [1, 2, 99] {
        let observed = Observed {
            log: RefCell::new(Vec::new()),
            fail,
        };
        let result = prepare_observing(&captured, &sid, &paths, &observed);
        if fail == 99 {
            assert!(result.is_ok());
            assert_eq!(
                &*observed.log.borrow(),
                &["rootless", "rootless", "gpu", "hostname"]
            );
        } else {
            assert!(matches!(result, Err(LaunchPreparationError::Rootless(_))));
            assert_eq!(observed.log.borrow().len(), fail);
        }
    }
}
