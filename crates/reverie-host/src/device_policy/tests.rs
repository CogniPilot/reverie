use super::*;
use reverie_core::resources::{BudgetMode, CpuQuota};
use std::cell::RefCell;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const E: &str = "11111111-1111-4111-8111-111111111111";
const F: &str = "22222222-2222-4222-8222-222222222222";
const S: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const D: &str = "nvidia.com/gpu=GPU-aBCDef12-3456-7890-ABcd-0123456789EF";
static NEXT: AtomicU64 = AtomicU64::new(0);
pub(super) enum Point {
    GpuProjected,
    MemoryProjected,
}
type Hook = Box<dyn FnOnce(Point)>;
thread_local! { static HOOK:RefCell<Option<Hook>>=RefCell::new(None); }
pub(super) fn hit(point: Point) {
    if let Some(hook) = HOOK.with(|value| value.borrow_mut().take()) {
        hook(point);
    }
}
fn inject(hook: impl FnOnce(Point) + 'static) {
    HOOK.with(|value| *value.borrow_mut() = Some(Box::new(hook)));
}
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-device-host-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let tree = Self { root };
        tree.company(E, S, 1);
        tree
    }
    fn company_file(&self) -> PathBuf {
        self.root.join("company.json")
    }
    fn identity(&self) -> StorageIdentityConfig {
        StorageIdentityConfig::try_new(
            self.company_file(),
            self.root.join("state"),
            self.root.join("scratch"),
            crate::native::uid(),
        )
        .unwrap()
    }
    fn company(&self, employee: &str, session: &str, generation: u64) {
        write(&self.company_file(), &row(employee, session, generation));
    }
    fn memory(&self) -> EffectiveWorkerConfig {
        config(&format!(
            "{{\"employeeMemoryPolicies\":{{\"{E}\":{{\"memoryHighMiB\":1024,\"swapMiB\":2048}}}},\"laptopSwapPoolMiB\":4096}}"
        ))
    }
    fn gpu(&self) -> EffectiveWorkerConfig {
        config(&format!("{{\"employeeGpuGrants\":{{\"{E}\":\"{D}\"}}}}"))
    }
    fn historical(&self) {
        self.company(E, T, 2);
        write(
            &self.root.join("plan-moves.json"),
            &format!(
                "[{{\"employeeId\":\"{E}\",\"oldSession\":\"{S}\",\"newSession\":\"{T}\",\"phase\":\"completed\"}}]"
            ),
        );
    }
    fn fd_count(&self) -> usize {
        fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
            .filter(|path| path.starts_with(&self.root))
            .count()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        HOOK.with(|value| *value.borrow_mut() = None);
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn write(path: &Path, raw: &str) {
    fs::write(path, raw).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn row(employee: &str, session: &str, generation: u64) -> String {
    format!(
        "{{\"employees\":[{{\"id\":\"{employee}\",\"sessionId\":\"{session}\",\"sessionGeneration\":{generation}}}],\"retired\":[]}}"
    )
}
fn config(raw: &str) -> EffectiveWorkerConfig {
    reverie_contracts::worker_config::decode(raw.as_bytes()).unwrap()
}
fn sid(value: &str) -> ProfileSessionId {
    ProfileSessionId::parse(value).unwrap()
}
fn ram() -> ResourcePolicy {
    ResourcePolicy::try_new(
        BudgetMode::Admission,
        4096,
        512,
        CpuQuota::from_float(1.0).unwrap(),
        8192,
        1024,
    )
    .unwrap()
}
fn resources() -> EffectiveWorkerConfig {
    config(r#"{"memoryMiB":4096,"opaque":{"cpu":1.0,"text":"\ud800","negative":-0.0}}"#)
}
fn effective_resources(memory: &str) -> EffectiveWorkerConfig {
    config(&format!(
        "{{\"budgetMode\":\"admission\",\"memoryMiB\":{memory},\"pidsLimit\":512,\"cpus\":1.0,\"poolMemoryMiB\":8192,\"poolTasksMax\":1024,\"opaque\":NaN}}"
    ))
}

#[test]
fn actual_current_gpu_projection_preserves_case_and_off_vacation_identity() {
    let tree = Tree::new();
    let identity = tree.identity();
    let gpu = tree.gpu();
    let grants = projected_gpu_grants(&gpu, &identity, &sid(S))
        .unwrap()
        .unwrap();
    assert_eq!(grants[&sid(S)].as_str(), D);
    assert_eq!(
        gpu_create_args(&gpu, &identity, &sid(S)).unwrap(),
        [
            "--device",
            D,
            "--env",
            "LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/local/nvidia/lib"
        ]
    );
    write(
        &tree.company_file(),
        &format!(
            "{{\"employees\":[{{\"id\":\"{E}\",\"sessionId\":\"{S}\",\"sessionGeneration\":2,\"desiredRunning\":false,\"onVacation\":true}}]}}"
        ),
    );
    assert!(
        projected_gpu_grants(&gpu, &identity, &sid(S))
            .unwrap()
            .is_some()
    );
    assert_eq!(tree.fd_count(), 0);
}
#[test]
fn historical_and_retired_storage_select_memory_but_never_derived_gpu() {
    let tree = Tree::new();
    let identity = tree.identity();
    tree.historical();
    assert_eq!(
        projected_gpu_grants(&tree.gpu(), &identity, &sid(S)).unwrap(),
        None
    );
    assert!(
        projected_gpu_grants(&tree.gpu(), &identity, &sid(T))
            .unwrap()
            .is_some()
    );
    let projected = project_memory(
        &tree.memory(),
        &identity,
        &sid(S),
        resources(),
        Some(&ram()),
    )
    .unwrap();
    assert_eq!(projected.swap_bytes(), 2_147_483_648);
    write(
        &tree.company_file(),
        &format!(
            "{{\"employees\":[],\"retired\":[{{\"id\":\"{E}\",\"sessionId\":\"{S}\",\"sessionGeneration\":1}}]}}"
        ),
    );
    fs::remove_file(tree.root.join("plan-moves.json")).unwrap();
    assert_eq!(
        projected_gpu_grants(&tree.gpu(), &identity, &sid(S)).unwrap(),
        None
    );
    assert!(
        project_memory(
            &tree.memory(),
            &identity,
            &sid(S),
            resources(),
            Some(&ram())
        )
        .unwrap()
        .policy()
        .is_some()
    );
    assert_eq!(tree.fd_count(), 0);
}
#[test]
fn legacy_gpu_and_inactive_features_never_read_unavailable_metadata() {
    let tree = Tree::new();
    let identity = tree.identity();
    fs::remove_file(tree.company_file()).unwrap();
    let gpu = config(&format!(
        "{{\"gpuGrants\":{{\"{S}\":\"{D}\"}},\"employeeGpuGrants\":{{\"{E}\":\"{D}\"}}}}"
    ));
    assert_eq!(gpu_create_args(&gpu, &identity, &sid(S)).unwrap().len(), 4);
    assert_eq!(
        projected_gpu_grants(&config("{}"), &identity, &sid(S)).unwrap(),
        None
    );
    let source = config(r#"{"gpuGrants":false,"employeeGpuGrants":{}}"#);
    assert!(project_gpu_resources(&source, &identity, &sid(S), resources()).is_ok());
    let source = config(r#"{"employeeMemoryPolicies":null,"laptopSwapPoolMiB":true}"#);
    let projection = project_memory_resources(
        &source,
        &identity,
        &sid(S),
        config(r#"{"memoryMiB":NaN}"#),
        None,
    )
    .unwrap();
    assert!(projection.policy().is_none());
    assert!(project_memory(&source, &identity, &sid(S), resources(), None).is_err());
    assert!(!tree.root.join("state").exists());
}
#[test]
fn actual_metadata_custody_errors_never_turn_into_unselected_gpu_or_memory() {
    for mode in [0o620, 0o602] {
        let tree = Tree::new();
        let identity = tree.identity();
        fs::set_permissions(tree.company_file(), fs::Permissions::from_mode(mode)).unwrap();
        assert!(projected_gpu_grants(&tree.gpu(), &identity, &sid(S)).is_err());
        assert!(
            project_memory(
                &tree.memory(),
                &identity,
                &sid(S),
                resources(),
                Some(&ram())
            )
            .is_err()
        );
        assert_eq!(tree.fd_count(), 0);
    }
    let tree = Tree::new();
    let identity = tree.identity();
    let moved = tree.root.join("moved.json");
    fs::rename(tree.company_file(), &moved).unwrap();
    symlink(&moved, tree.company_file()).unwrap();
    assert!(projected_gpu_grants(&tree.gpu(), &identity, &sid(S)).is_err());
    assert!(
        project_memory(
            &tree.memory(),
            &identity,
            &sid(S),
            resources(),
            Some(&ram())
        )
        .is_err()
    );
    assert_eq!(tree.fd_count(), 0);
}
#[test]
fn observed_gpu_generation_or_owner_rebinding_refuses_the_candidate() {
    for replacement in [
        row(E, S, 2),
        row(F, S, 1),
        format!(
            "{{\"employees\":[{{\"id\":\"{E}\",\"sessionId\":\"{S}\",\"sessionGeneration\":1,\"owner\":\"james\"}}]}}"
        ),
        row(E, T, 1),
    ] {
        let tree = Tree::new();
        let identity = tree.identity();
        let company = tree.company_file();
        inject(move |point| {
            assert!(matches!(point, Point::GpuProjected));
            write(&company, &replacement);
        });
        let error = projected_gpu_grants(&tree.gpu(), &identity, &sid(S)).unwrap_err();
        assert_eq!(error.code(), "GPU_EMPLOYEE_BINDING_CHANGED");
        assert_eq!(tree.fd_count(), 0);
    }
}
#[test]
fn observed_memory_storage_rebinding_refuses_but_generation_only_changes_do_not() {
    let tree = Tree::new();
    let identity = tree.identity();
    let company = tree.company_file();
    inject(move |point| {
        assert!(matches!(point, Point::MemoryProjected));
        write(&company, &row(F, S, 2));
    });
    let error = project_memory(
        &tree.memory(),
        &identity,
        &sid(S),
        resources(),
        Some(&ram()),
    )
    .err()
    .unwrap();
    assert_eq!(error.code(), "MEMORY_STORAGE_BINDING_CHANGED");
    tree.company(E, S, 1);
    let company = tree.company_file();
    inject(move |_| write(&company, &row(E, S, 99)));
    assert!(
        project_memory(
            &tree.memory(),
            &identity,
            &sid(S),
            resources(),
            Some(&ram())
        )
        .is_ok()
    );
    assert_eq!(tree.fd_count(), 0);
}
#[test]
fn unbound_swap_only_and_nil_storage_cases_preserve_selection_rules() {
    let tree = Tree::new();
    let identity = tree.identity();
    let policies = tree.memory();
    let unbound = project_memory(
        &policies,
        &identity,
        &sid(T),
        config(r#"{"memoryMiB":"opaque"}"#),
        None,
    )
    .unwrap();
    assert!(unbound.policy().is_none());
    let only_swap = config(&format!(
        "{{\"employeeMemoryPolicies\":{{\"{E}\":{{\"swapMiB\":0}}}}}}"
    ));
    assert!(
        project_memory(
            &only_swap,
            &identity,
            &sid(S),
            config(r#"{"memoryMiB":NaN}"#),
            None
        )
        .unwrap()
        .policy()
        .is_some()
    );
    let nil = "00000000-0000-0000-0000-000000000000";
    tree.company(nil, nil, 1);
    let gpu = config(&format!("{{\"employeeGpuGrants\":{{\"{nil}\":\"{D}\"}}}}"));
    assert!(
        projected_gpu_grants(&gpu, &identity, &sid(nil))
            .unwrap()
            .is_some()
    );
    assert_eq!(tree.fd_count(), 0);
}
#[test]
fn effective_memory_checks_actual_resources_only_after_selecting_high() {
    let tree = Tree::new();
    let identity = tree.identity();
    let policies = tree.memory();
    let projection = project_effective_memory_resources(
        &policies,
        &identity,
        &sid(S),
        effective_resources("4096"),
    )
    .unwrap();
    assert_eq!(projection.swap_bytes(), 2_147_483_648);
    for resources in [
        resources(),
        effective_resources("NaN"),
        effective_resources("4096.0"),
        effective_resources("1024"),
    ] {
        assert!(
            project_effective_memory_resources(&policies, &identity, &sid(S), resources).is_err()
        );
    }
    let opaque = r#"{"memoryMiB":"unvalidated", "cpus":NaN}"#;
    assert!(
        project_effective_memory_resources(&policies, &identity, &sid(T), config(opaque)).is_ok()
    );
    let swap_only = config(&format!(
        "{{\"employeeMemoryPolicies\":{{\"{E}\":{{\"swapMiB\":0}}}}}}"
    ));
    assert!(
        project_effective_memory_resources(&swap_only, &identity, &sid(S), config(opaque)).is_ok()
    );
    fs::remove_file(tree.company_file()).unwrap();
    assert!(
        project_effective_memory_resources(&config("{}"), &identity, &sid(S), config(opaque))
            .is_ok()
    );
    assert_eq!(tree.fd_count(), 0);
}

#[test]
fn frozen_session_memory_precedes_employee_lookup_in_host_projections() {
    let tree = Tree::new();
    let identity = tree.identity();
    fs::remove_file(tree.company_file()).unwrap();
    for snapshot in [
        "null",
        r#"{"memoryHighMiB":1024,"swapMiB":0,"swapPoolMiB":0}"#,
    ] {
        let source = config(&format!(
            r#"{{"sessionResources":{{"{S}":{{"version":2,"resources":{{"budgetMode":"admission","memoryMiB":4096,"pidsLimit":512,"cpus":1.0,"poolMemoryMiB":8192,"poolTasksMax":1024}},"memoryPolicy":{snapshot}}}}},"employeeMemoryPolicies":{{"{E}":{{"memoryHighMiB":2048,"swapMiB":0}}}}}}"#
        ));
        let projected = project_effective_memory_resources(
            &source,
            &identity,
            &sid(S),
            effective_resources("4096"),
        )
        .unwrap();
        assert_eq!(projected.policy().is_some(), snapshot != "null");
        let other = project_memory_resources(
            &source,
            &identity,
            &sid(S),
            effective_resources("4096"),
            None,
        )
        .unwrap();
        assert_eq!(
            reverie_contracts::worker_config::encode_config(projected.configuration()),
            reverie_contracts::worker_config::encode_config(other.configuration())
        );
    }
    assert_eq!(tree.fd_count(), 0);
}
#[test]
fn effective_memory_derivation_remains_inside_storage_binding_observations() {
    let tree = Tree::new();
    let identity = tree.identity();
    let company = tree.company_file();
    inject(move |point| {
        assert!(matches!(point, Point::MemoryProjected));
        write(&company, &row(F, S, 1));
    });
    let error = project_effective_memory_resources(
        &tree.memory(),
        &identity,
        &sid(S),
        effective_resources("4096"),
    )
    .err()
    .unwrap();
    assert_eq!(error.code(), "MEMORY_STORAGE_BINDING_CHANGED");
    assert_eq!(tree.fd_count(), 0);
}
