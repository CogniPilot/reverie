use super::*;
use crate::engine_metadata::{CancellationToken, EngineBootstrap, ReadonlyEngine};
use std::{
    collections::BTreeMap,
    os::unix::fs::PermissionsExt,
    sync::atomic::{AtomicU64, Ordering},
};
const DEVICE: &str = "GPU-11111111-2222-3333-4444-555555555555";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(std::path::PathBuf);
impl Tree {
    fn new() -> Self {
        let program = crate::engine_metadata::tests::program();
        let path = std::env::temp_dir().join(format!(
            "gpu-cdi-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let tree = Self(path);
        fs::create_dir(tree.0.join("cdi")).unwrap();
        tree.write("cdi/device.json", &spec("/dev/nvidia0"));
        tree.write("replacement-spec.json", &spec("/dev/nvidia7"));
        tree.write("info.json",&serde_json::to_vec(&serde_json::json!({"OSType":"linux","KernelVersion":native::kernel_release().unwrap(),"CDISpecDirs":[tree.0.join("cdi")]})).unwrap());
        fs::hard_link(program, tree.0.join("gpu-info")).unwrap();
        tree
    }
    fn write(&self, name: &str, raw: &[u8]) {
        let path = self.0.join(name);
        fs::write(&path, raw).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn engine(&self) -> ReadonlyEngine {
        ReadonlyEngine::new(
            EngineBootstrap::from_service(
                self.0.join("gpu-info").as_os_str(),
                BTreeMap::new(),
                self.0.clone(),
            )
            .unwrap(),
        )
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn spec(path: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"kind":"nvidia.com/gpu","devices":[{"name":DEVICE,"containerEdits":{"deviceNodes":[{"path":path}]}}]})).unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn inspect_twice(engine: &ReadonlyEngine) -> Result<CdiObservation> {
    let device = GpuDeviceUuid::parse(DEVICE).unwrap();
    let cancel = CancellationToken::new();
    let bound = end();
    let info = GpuHardware::engine_information(engine, bound, &cancel)?;
    let first = GpuHardware::cdi(&info, &device, bound)?;
    let second = GpuHardware::cdi(&info, &device, bound)?;
    need(first.equivalent(&second), "GPU_CDI_OR_HARDWARE_CHANGED")?;
    let next_info = GpuHardware::engine_information(engine, bound, &cancel)?;
    need(info.equivalent(&next_info), "GPU_CDI_OR_HARDWARE_CHANGED")?;
    second.assert_current()?;
    Ok(second)
}
#[test]
fn actual_second_fixed_info_cannot_rebind_cdi_identity_to_unparsed_replacement() {
    let tree = Tree::new();
    tree.write("replace-on-second-info", b"owned control");
    let engine = tree.engine();
    let result = inspect_twice(&engine);
    let closed = engine.close(end());
    assert!(closed.is_ok());
    assert_eq!(result.err().unwrap().code(), "GPU_CDI_OR_HARDWARE_CHANGED");
    assert_eq!(
        fs::read(tree.0.join("cdi/device.json")).unwrap(),
        spec("/dev/nvidia7")
    );
    assert_eq!(fs::read_to_string(tree.0.join("info-count")).unwrap(), "2");
    assert!(!tree.0.join("resource-reservation-control.pending").exists());
}
#[test]
fn unchanged_protected_cdi_survives_both_actual_same_context_information_queries() {
    let tree = Tree::new();
    let engine = tree.engine();
    let result = inspect_twice(&engine);
    let closed = engine.close(end());
    assert!(closed.is_ok());
    let observed = result.unwrap();
    assert_eq!(
        observed.edits().numeric_nodes()[0].scalar_text().unwrap(),
        "/dev/nvidia0"
    );
    let reference: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../reverie-contracts/tests/fixtures/gpu_access/cdi.json"
    ))
    .unwrap();
    let format = reference["engineInfoFormat"].as_str().unwrap();
    assert_eq!(
        fs::read_to_string(tree.0.join("calls.txt")).unwrap(),
        format!("info\0--format\0{format}\ninfo\0--format\0{format}\n")
    );
}
