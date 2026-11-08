use super::*;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    file: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let mut nonce = [0; 16];
        getrandom::getrandom(&mut nonce).unwrap();
        let base =
            std::env::temp_dir().join(format!("pool-request-{:032x}", u128::from_ne_bytes(nonce)));
        let root = base.join("reverie");
        for path in [&base, &root, &root.join("worker-pool")] {
            fs::DirBuilder::new().mode(0o700).create(path).unwrap();
        }
        let file = root.join("worker-pool/registration-request.json");
        let fixture = Self { base, root, file };
        fixture.write(fixture.data());
        fixture
    }
    fn data(&self) -> serde_json::Value {
        serde_json::json!({"purpose":"host-pool-installation-request-v1","version":1,
            "principal":{"accountId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","personId":"owner","sessionEpoch":3},
            "policy":{"version":1,"purpose":"reverie-docker-worker-pool-v1","deployment":"nomination-fixture",
                "instanceRoot":self.root,"engineId":"11111111-2222-4333-8444-555555555555",
                "anchorImage":format!("sha256:{}","a".repeat(64)),"controllerImage":format!("sha256:{}","b".repeat(64)),
                "websiteContainer":"c".repeat(64),"brokerUid":native::uid(),"brokerGid":nix::unistd::getegid().as_raw(),
                "memoryMaxMiB":49152,"poolTasksMax":8192,"cpuWeight":100,"allowedCpus":[0,1],
                "employeeMemoryHighMiB":{"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee":1024}}})
    }
    fn write(&self, data: serde_json::Value) {
        fs::write(&self.file, serde_json::to_vec(&data).unwrap()).unwrap();
        fs::set_permissions(&self.file, fs::Permissions::from_mode(0o600)).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
    }
}

#[test]
fn actual_private_nomination_is_data_bound_to_instance_and_process_account() {
    let fixture = Fixture::new();
    let request = read_request(fixture.root.clone()).unwrap();
    assert_eq!(
        request.policy().instance_root,
        fixture.root.to_str().unwrap()
    );
    for (field, value, error) in [
        (
            "instanceRoot",
            serde_json::json!("/home/another/reverie"),
            "POOL_REQUEST_INSTANCE",
        ),
        (
            "brokerUid",
            serde_json::json!(native::uid() + 1),
            "POOL_REQUEST_BROKER_IDS",
        ),
    ] {
        let mut data = fixture.data();
        data["policy"][field] = value;
        fixture.write(data);
        assert_eq!(
            read_request(fixture.root.clone()).err().unwrap().code(),
            error
        );
    }
}

#[test]
fn actual_symlinks_hard_links_and_shared_permissions_cannot_select_nomination() {
    let fixture = Fixture::new();
    fs::set_permissions(&fixture.file, fs::Permissions::from_mode(0o640)).unwrap();
    assert!(read_request(fixture.root.clone()).is_err());
    fs::set_permissions(&fixture.file, fs::Permissions::from_mode(0o600)).unwrap();
    let linked = fixture.base.join("linked");
    fs::hard_link(&fixture.file, &linked).unwrap();
    assert!(read_request(fixture.root.clone()).is_err());
    fs::remove_file(&linked).unwrap();
    fs::rename(&fixture.file, &linked).unwrap();
    symlink(&linked, &fixture.file).unwrap();
    assert!(read_request(fixture.root.clone()).is_err());
    assert!(linked.is_file());
}

#[test]
fn shared_or_rebound_parent_and_oversized_input_refuse_without_publication() {
    let fixture = Fixture::new();
    let pool = fixture.root.join("worker-pool");
    fs::set_permissions(&pool, fs::Permissions::from_mode(0o750)).unwrap();
    assert!(read_request(fixture.root.clone()).is_err());
    fs::set_permissions(&pool, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(&fixture.file, vec![b' '; 65_537]).unwrap();
    assert!(read_request(fixture.root.clone()).is_err());
    let moved = fixture.base.join("moved-pool");
    fs::rename(&pool, &moved).unwrap();
    symlink(&moved, &pool).unwrap();
    assert!(read_request(fixture.root.clone()).is_err());
    assert!(!fixture.root.join("worker-pool/policies").exists());
}
