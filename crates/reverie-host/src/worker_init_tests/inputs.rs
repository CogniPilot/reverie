use super::*;
use crate::native;
use reverie_contracts::task_perf_capsule::{MAX_INVENTORY_BYTES, PerfCapsuleInventory};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(super) struct Inputs {
    pub(super) image: String,
    pub(super) image_spec: serde_json::Value,
    pub(super) init: PathBuf,
    pub(super) digest: String,
    pub(super) closure: Vec<PathBuf>,
}
impl Inputs {
    pub(super) fn capture() -> Self {
        let info: serde_json::Value =
            serde_json::from_str(&docker::run(&["info", "--format", "{{json .}}"]).unwrap())
                .unwrap();
        assert_eq!(info["CgroupDriver"], "systemd");
        assert_eq!(info["CgroupVersion"], "2");
        let image =
            std::env::var("REVERIE_INIT_FIXTURE_IMAGE").expect("reviewed immutable image ID");
        assert!(
            image
                .strip_prefix("sha256:")
                .is_some_and(reverie_contracts::worker_pool::hex_id)
        );
        let capsule = PathBuf::from(
            std::env::var_os("REVERIE_INIT_FIXTURE_CAPSULE").expect("pinned static Nix capsule"),
        );
        assert_eq!(capsule.parent(), Some(Path::new("/nix/store")));
        assert_eq!(fs::canonicalize(&capsule).unwrap(), capsule);
        let prefix = capsule.join("opt/reverie/perf");
        let inventory = PerfCapsuleInventory::decode(
            &native::observe(
                &prefix.join("build-inputs.json"),
                MAX_INVENTORY_BYTES,
                super::super::task_perf::allowed_metadata,
            )
            .unwrap(),
        )
        .unwrap();
        let init = prefix.join("bin/reverie-worker-init");
        let digest = inventory.code_files()["bin/reverie-worker-init"]
            .as_str()
            .to_owned();
        let bytes = native::observe(
            &init,
            64 * 1024 * 1024,
            super::super::task_perf::allowed_metadata,
        )
        .unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), digest);
        assert!(bytes.starts_with(b"\x7fELF"));
        let path = std::env::var_os("REVERIE_INIT_FIXTURE_CLOSURE")
            .expect("reviewed public Nix closure JSON");
        let raw = fs::read(path).unwrap();
        assert!(raw.len() <= 4_194_304);
        let data: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        let entries = data.as_object().unwrap();
        assert!(!entries.is_empty() && entries.len() <= 4096);
        let mut closure = Vec::new();
        for (name, metadata) in entries {
            let path = PathBuf::from(name);
            assert_eq!(path.parent(), Some(Path::new("/nix/store")));
            assert_eq!(fs::canonicalize(&path).unwrap(), path);
            for reference in metadata["references"].as_array().unwrap() {
                assert!(entries.contains_key(reference.as_str().unwrap()));
            }
            closure.push(path);
        }
        let inspected: serde_json::Value =
            serde_json::from_str(&docker::run(&["image", "inspect", &image]).unwrap()).unwrap();
        assert_eq!(inspected[0]["Id"], image);
        assert_eq!(
            inspected[0]["Config"]["Entrypoint"],
            serde_json::json!([INIT])
        );
        assert_eq!(inspected[0]["Config"]["User"], "1000:100");
        assert!(
            inspected[0]["Config"]["Cmd"].is_null()
                || inspected[0]["Config"]["Cmd"] == serde_json::json!([]),
            "image default command must already be empty before create"
        );
        Self {
            image,
            image_spec: inspected[0].clone(),
            init,
            digest,
            closure,
        }
    }
}
